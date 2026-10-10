//! Thin wrappers over the `attricat:host@1.0.0` imports. Every call is checked
//! by the host against this release's granted capabilities.

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::attricat::host::api::{
    self, ConfigurationScope, ConfigurationScopeKind, ReadRequest, RecordReference, ResolvedRead,
    ScalarWrite, ScopedConfigurationUpdate, WriteRequest,
};
use crate::formulas::{AttributeSettings, BlueprintWithAttributes};

pub const RECALCULATED_CONTRACT: &str = "formula-recalculated";

pub fn decode<T: DeserializeOwned>(value: &str, label: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|error| format!("Invalid {label}: {error}"))
}

pub fn encode(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|_| "Response serialization failed.".to_owned())
}

#[derive(Deserialize)]
pub struct AttricatRecord {
    pub id: String,
}

pub struct ReadRecord {
    pub record: AttricatRecord,
    pub blueprint: BlueprintWithAttributes,
}

/// Reads a record with its pinned blueprint revision. Not available inside
/// operation runs, which read catalog data only through their selection.
pub fn read_record(record_id: &str) -> Result<ReadRecord, String> {
    let response = api::read(&ReadRequest::Record(RecordReference {
        record_id: record_id.into(),
    }))?;
    Ok(ReadRecord {
        record: decode(&response.record, "record")?,
        blueprint: decode(&response.blueprint, "blueprint")?,
    })
}

/// Values resolved by the host in `context_id`, keyed by attribute code.
pub fn resolved_values(record_id: &str, context_id: &str) -> Result<Value, String> {
    let response = api::read(&ReadRequest::Resolved(ResolvedRead {
        record_id: record_id.into(),
        context_id: context_id.into(),
    }))?;
    let resolved: Value = decode(
        &response
            .resolved_values
            .ok_or_else(|| "The host returned no resolved values.".to_owned())?,
        "resolved values",
    )?;
    Ok(resolved.get("values").cloned().unwrap_or(Value::Null))
}

/// The direct (not fallback-resolved) value in `context_id`. A target inherited
/// from a parent context still receives its own derived value.
pub fn direct_number(
    record_id: &str,
    context_id: &str,
    attribute_id: &str,
) -> Result<Option<f64>, String> {
    let response = api::read(&ReadRequest::Values(RecordReference {
        record_id: record_id.into(),
    }))?;
    let values: Vec<Value> = decode(&response.direct_values, "direct values")?;
    Ok(values
        .iter()
        .find(|entry| {
            entry.get("attribute_id").and_then(Value::as_str) == Some(attribute_id)
                && entry.get("context_id").and_then(Value::as_str) == Some(context_id)
                && entry.get("active").and_then(Value::as_bool) != Some(false)
        })
        .and_then(|entry| entry.get("value"))
        .and_then(Value::as_f64))
}

pub fn write_number(
    record_id: &str,
    context_id: &str,
    attribute_id: &str,
    value: f64,
) -> Result<(), String> {
    api::write(&WriteRequest {
        record_id: record_id.into(),
        values: vec![ScalarWrite {
            attribute_id: Some(attribute_id.into()),
            attribute_code: None,
            context_id: context_id.into(),
            value: encode(&value)?,
        }],
    })?;
    Ok(())
}

fn attribute_scope(
    blueprint_id: &str,
    blueprint_version: i64,
    attribute_id: &str,
) -> ConfigurationScope {
    ConfigurationScope {
        kind: ConfigurationScopeKind::Attribute,
        blueprint_id: blueprint_id.into(),
        blueprint_version,
        attribute_id: Some(attribute_id.into()),
    }
}

pub fn attribute_settings(
    blueprint_id: &str,
    blueprint_version: i64,
    attribute_id: &str,
) -> Result<AttributeSettings, String> {
    match api::scoped_configuration_get(&attribute_scope(
        blueprint_id,
        blueprint_version,
        attribute_id,
    ))? {
        Some(value) => decode(&value, "attribute settings"),
        None => Ok(AttributeSettings::default()),
    }
}

pub fn save_attribute_settings(
    blueprint_id: &str,
    blueprint_version: i64,
    attribute_id: &str,
    settings: &AttributeSettings,
) -> Result<(), String> {
    settings.validate()?;
    api::scoped_configuration_set(&ScopedConfigurationUpdate {
        scope: attribute_scope(blueprint_id, blueprint_version, attribute_id),
        value: encode(settings)?,
    })
}

#[derive(Deserialize)]
struct StoredEntry<T> {
    value: T,
    revision: i64,
}

pub fn storage_get<T: DeserializeOwned>(key: &str) -> Result<Option<(T, i64)>, String> {
    let response = api::call("storage.get.v1", &json!({"key": key}).to_string())?;
    let entry: Option<StoredEntry<T>> = decode(&response, "storage entry")?;
    Ok(entry.map(|entry| (entry.value, entry.revision)))
}

pub fn storage_set(
    key: &str,
    value: &impl Serialize,
    expected_revision: Option<i64>,
) -> Result<(), String> {
    let request = json!({"key": key, "value": value, "expected_revision": expected_revision});
    api::call("storage.set.v1", &request.to_string())?;
    Ok(())
}

/// Read-modify-write with optimistic concurrency. Event deliveries for one
/// extension may run concurrently, so a conflicting update is retried.
pub fn storage_update<T, F>(key: &str, mut update: F) -> Result<(), String>
where
    T: DeserializeOwned + Serialize + Default,
    F: FnMut(&mut T),
{
    let mut last_error = String::new();
    for _ in 0..5 {
        let (mut value, revision) = match storage_get::<T>(key)? {
            Some((value, revision)) => (value, Some(revision)),
            None => (T::default(), None),
        };
        update(&mut value);
        match storage_set(key, &value, revision) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

/// Publishes the manifest-declared `formula-recalculated` event contract.
pub fn emit_recalculated(record_id: &str, payload: Value) -> Result<(), String> {
    let request = json!({
        "contract_id": RECALCULATED_CONTRACT,
        "aggregate_kind": "record",
        "aggregate_id": record_id,
        "payload": payload,
    });
    api::call("events.emit.v1", &request.to_string())?;
    Ok(())
}

/// Best-effort structured logging; a log failure never fails the work.
pub fn log(level: &str, message: &str) {
    let _ = api::log(level, message);
}
