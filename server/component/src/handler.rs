//! The `event-handler` export (the `record.updated.v1` handler) and the
//! `command-handler` export (the client commands declared in
//! `server.commands`).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::activity::{self, Activity, Entry};
use crate::attricat::host::api::Event;
use crate::attricat::host::clock;
use crate::attricat::host::outcomes::{Failure, Rejection};
use crate::exports::attricat::host::command_handler::{CommandRequest, CommandResponse};
use crate::exports::attricat::host::event_handler::Delivery;
use crate::formulas::{self, AttributeSettings, Evaluation, FormulaConfig, FormulaIndex};
use crate::host::{self, decode, encode};

#[derive(Deserialize)]
struct RecordUpdated {
    record_id: String,
    facts: Vec<ChangedFact>,
}

#[derive(Deserialize)]
struct ChangedFact {
    attribute_id: String,
    context_id: Option<String>,
}

/// The `source-name` of events caused by this extension's own writes.
const OWN_SOURCE: &str = "extension:attricat-extension-example";

/// Recalculates formulas whose inputs changed, in the context they changed in.
///
/// Formulas run in dependency order and a written target counts as a changed
/// input for the formulas after it, so one delivery completes a whole chain
/// and the events caused by those writes are skipped by their source.
///
/// Per-formula problems (a non-numeric input) are recorded in the activity
/// log and the delivery succeeds. Invalid formulas and an unreadable payload
/// are rejected: recorded by the host, never retried. Host call failures are
/// retried with backoff (see `From<String> for Failure`).
pub fn handle_event(event: Event, delivery: Delivery) -> Result<(), Failure> {
    if event.event_type != "record.updated.v1" || delivery.source_name == OWN_SOURCE {
        return Ok(());
    }
    let rejected = |code: &str, message: String, record_id: Option<String>| {
        Failure::Rejected(Rejection {
            code: code.into(),
            message,
            record_id,
            connection: None,
        })
    };
    let changed: RecordUpdated = decode(&event.payload, "record.updated.v1 payload")
        .map_err(|error| rejected("invalid_payload", error, None))?;
    let mut contexts: BTreeMap<&str, BTreeSet<String>> = BTreeMap::new();
    for fact in &changed.facts {
        if let Some(context_id) = fact.context_id.as_deref() {
            contexts
                .entry(context_id)
                .or_default()
                .insert(fact.attribute_id.clone());
        }
    }
    if contexts.is_empty() {
        return Ok(());
    }
    let read = host::read_record(&changed.record_id)?;
    let index = activity::refresh_index(&read.blueprint);
    let reference = Some(event.id.clone());
    if let Some(error) = &index.error {
        activity::record(
            &[Entry::error(
                "event",
                reference,
                Some(changed.record_id.clone()),
                error,
            )],
            0,
        );
        return Err(rejected(
            "invalid_formulas",
            error.clone(),
            Some(changed.record_id),
        ));
    }
    let mut entries = Vec::new();
    let mut evaluations = 0;
    for (context_id, mut changed_ids) in contexts {
        for formula in &index.formulas {
            if !formula
                .dependencies
                .iter()
                .any(|dependency| changed_ids.contains(dependency))
            {
                continue;
            }
            evaluations += 1;
            if let Some(entry) = recalculate(
                &changed.record_id,
                context_id,
                &index.blueprint_id,
                index.blueprint_version,
                formula,
                "event",
                reference.clone(),
            )? {
                if entry.written {
                    changed_ids.insert(formula.target_attribute_id.clone());
                }
                entries.push(entry);
            }
        }
    }
    activity::record(&entries, evaluations);
    annotate_recalculated(&event, &changed.record_id, &entries);
    Ok(())
}

/// Records what this delivery wrote in the record's own annotation namespace
/// (`system_metadata["attricat-extension-example"].last_recalculated`). The
/// intent key is the event ID, so a redelivered event is `already_applied`.
/// Like the activity log it is bookkeeping: a failure is logged, never
/// retried, because the formula writes already happened.
fn annotate_recalculated(event: &Event, record_id: &str, entries: &[Entry]) {
    let written: Vec<_> = entries.iter().filter(|entry| entry.written).collect();
    if written.is_empty() {
        return;
    }
    let targets: BTreeSet<_> = written
        .iter()
        .filter_map(|entry| entry.target_code.as_deref())
        .collect();
    let contexts: BTreeSet<_> = written
        .iter()
        .filter_map(|entry| entry.context_id.as_deref())
        .collect();
    let metadata = json!({"last_recalculated": {
        "event_id": event.id,
        "targets": targets,
        "context_ids": contexts,
        "at": clock::now().seconds,
    }});
    if let Err(error) = host::annotate(&format!("recalculated:{}", event.id), record_id, metadata) {
        host::log("warn", &format!("last_recalculated not annotated: {error}"));
    }
}

/// Evaluates one formula in one context and writes the target when its direct
/// value differs. Returns `None` while inputs are still missing.
fn recalculate(
    record_id: &str,
    context_id: &str,
    blueprint_id: &str,
    blueprint_version: i64,
    formula: &FormulaConfig,
    source: &str,
    reference: Option<String>,
) -> Result<Option<Entry>, String> {
    let settings = host::attribute_settings(
        blueprint_id,
        blueprint_version,
        &formula.target_attribute_id,
    )?;
    let values = host::resolved_values(record_id, context_id)?;
    let mut entry = Entry {
        source: source.into(),
        reference,
        record_id: Some(record_id.into()),
        context_id: Some(context_id.into()),
        target_code: Some(formula.target_code.clone()),
        result: None,
        written: false,
        error: None,
        at: None,
    };
    let result = match formulas::evaluate(&formula.expression, &values, &settings) {
        Ok(Evaluation {
            result: Some(result),
            ..
        }) => result,
        Ok(_) => return Ok(None),
        Err(error) => {
            entry.error = Some(error);
            return Ok(Some(entry));
        }
    };
    entry.result = Some(result);
    let current = host::direct_number(record_id, context_id, &formula.target_attribute_id)?;
    if formulas::same_value(current, Some(result)) {
        return Ok(Some(entry));
    }
    host::write_number(record_id, context_id, &formula.target_attribute_id, result)?;
    entry.written = true;
    let payload = json!({
        "record_id": record_id,
        "context_id": context_id,
        "target_code": formula.target_code,
        "result": result,
    });
    if let Err(error) = host::emit_recalculated(record_id, payload) {
        host::log(
            "warn",
            &format!("formula-recalculated not emitted: {error}"),
        );
    }
    Ok(Some(entry))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordRequest {
    record_id: String,
    #[serde(default)]
    context_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewRequest {
    record_id: String,
    context_id: String,
    expression: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AttributeRequest {
    blueprint_id: String,
    blueprint_version: i64,
    attribute_id: String,
    #[serde(default)]
    settings: Option<AttributeSettings>,
}

#[derive(Serialize)]
struct DescribedFormula<'a> {
    #[serde(flatten)]
    formula: &'a FormulaConfig,
    settings: AttributeSettings,
    evaluation: Option<Evaluation>,
    current: Option<f64>,
    up_to_date: bool,
    error: Option<String>,
}

pub fn handle_command(request: CommandRequest) -> Result<CommandResponse, String> {
    let payload = match request.handler.as_str() {
        "describe-formulas" => describe(decode(&request.payload, "describe request")?)?,
        "preview-formula" => preview(decode(&request.payload, "preview request")?)?,
        "recalculate-formulas" => {
            let input: RecordRequest = decode(&request.payload, "recalculate request")?;
            let context_id = input
                .context_id
                .ok_or_else(|| "Select a context to recalculate.".to_owned())?;
            encode(&json!({"results": recalculate_record(&input.record_id, &context_id)?}))?
        }
        "recalculate-action" => recalculate_action(decode(&request.payload, "action context")?)?,
        "check-formulas-action" => check_action(decode(&request.payload, "action context")?)?,
        "list-formulas-action" => list_action(decode(&request.payload, "action context")?)?,
        "get-attribute-settings" | "save-attribute-settings" => {
            let input: AttributeRequest = decode(&request.payload, "settings request")?;
            if request.handler == "save-attribute-settings" {
                let settings = input
                    .settings
                    .ok_or_else(|| "settings are required".to_owned())?;
                host::save_attribute_settings(
                    &input.blueprint_id,
                    input.blueprint_version,
                    &input.attribute_id,
                    &settings,
                )?;
            }
            let settings = host::attribute_settings(
                &input.blueprint_id,
                input.blueprint_version,
                &input.attribute_id,
            )?;
            encode(&json!({"settings": settings}))?
        }
        "list-templates" | "save-template" | "delete-template" => {
            crate::documents::templates::handle_command(&request.handler, &request.payload)?
        }
        "recent-activity" => {
            let activity = host::storage_get::<Activity>(activity::ACTIVITY_KEY)?
                .map(|(activity, _)| activity)
                .unwrap_or_default();
            encode(&activity)?
        }
        _ => return Err(format!("Unknown command handler `{}`.", request.handler)),
    };
    Ok(CommandResponse { payload })
}

/// Describes every formula of a record's revision and, when a context is
/// supplied, evaluates it there. Also refreshes the stored formula index.
fn describe(input: RecordRequest) -> Result<String, String> {
    let read = host::read_record(&input.record_id)?;
    let index = activity::refresh_index(&read.blueprint);
    let values = input
        .context_id
        .as_deref()
        .map(|context_id| host::resolved_values(&read.record.id, context_id))
        .transpose()?;
    let mut described = Vec::with_capacity(index.formulas.len());
    for formula in &index.formulas {
        let settings = host::attribute_settings(
            &index.blueprint_id,
            index.blueprint_version,
            &formula.target_attribute_id,
        )?;
        let (evaluation, error) = match &values {
            Some(values) => match formulas::evaluate(&formula.expression, values, &settings) {
                Ok(evaluation) => (Some(evaluation), None),
                Err(error) => (None, Some(error)),
            },
            None => (None, None),
        };
        let current = match input.context_id.as_deref() {
            Some(context_id) => {
                host::direct_number(&read.record.id, context_id, &formula.target_attribute_id)?
            }
            None => None,
        };
        let up_to_date = evaluation
            .as_ref()
            .is_some_and(|evaluation| formulas::same_value(current, evaluation.result));
        described.push(DescribedFormula {
            formula,
            settings,
            evaluation,
            current,
            up_to_date,
            error,
        });
    }
    encode(&json!({
        "blueprint_id": index.blueprint_id,
        "blueprint_version": index.blueprint_version,
        "context_id": input.context_id,
        "error": index.error,
        "formulas": described,
    }))
}

fn preview(input: PreviewRequest) -> Result<String, String> {
    let values = host::resolved_values(&input.record_id, &input.context_id)?;
    let evaluation = formulas::evaluate(&input.expression, &values, &AttributeSettings::default())?;
    encode(&evaluation)
}

fn recalculate_record(record_id: &str, context_id: &str) -> Result<Vec<Entry>, String> {
    let read = host::read_record(record_id)?;
    let index = activity::refresh_index(&read.blueprint);
    if let Some(error) = index.error {
        return Err(error);
    }
    let mut entries = Vec::new();
    for formula in &index.formulas {
        if let Some(entry) = recalculate(
            &read.record.id,
            context_id,
            &index.blueprint_id,
            index.blueprint_version,
            formula,
            "command",
            None,
        )? {
            entries.push(entry);
        }
    }
    activity::record(&entries, index.formulas.len() as u64);
    Ok(entries)
}

/// The context the host sends with a host-rendered action: the revision, the
/// value context and the records the action applies to. The host also sends
/// the action and outlet, which these commands do not need.
#[derive(Deserialize)]
struct ActionContext {
    blueprint_id: String,
    blueprint_version: i64,
    context_id: Option<String>,
    record_ids: Vec<String>,
}

/// What the host does after an action's command: show a notification and,
/// with `refresh`, reload the records the action applied to.
fn action_result(message: String, severity: &str, refresh: bool) -> Result<String, String> {
    encode(&json!({
        "notification": {"message": message, "severity": severity},
        "refresh": refresh,
    }))
}

fn only_record(input: &ActionContext) -> Result<&str, String> {
    match input.record_ids.as_slice() {
        [record_id] => Ok(record_id),
        _ => Err("this action applies to one record".to_owned()),
    }
}

/// "Recalculate formulas" on a record page: writes every formula of the
/// record's revision in the selected context.
fn recalculate_action(input: ActionContext) -> Result<String, String> {
    let record_id = only_record(&input)?;
    let Some(context_id) = input.context_id.as_deref() else {
        return action_result("Select a context to recalculate.".into(), "warning", false);
    };
    match recalculate_record(record_id, context_id) {
        Ok(entries) => {
            let written = entries.iter().filter(|entry| entry.written).count();
            let message = if written > 0 {
                format!("Updated {written} computed value(s).")
            } else {
                "Computed values are up to date.".to_owned()
            };
            action_result(message, "success", written > 0)
        }
        Err(error) => action_result(format!("Recalculation failed: {error}"), "error", false),
    }
}

/// "Check formulas" in a record's actions menu: validates the revision's
/// formulas, refreshing the stored index panels and runs read.
fn check_action(input: ActionContext) -> Result<String, String> {
    let read = host::read_record(only_record(&input)?)?;
    let index = activity::refresh_index(&read.blueprint);
    if let Some(error) = index.error {
        return action_result(format!("Formulas are invalid: {error}"), "error", false);
    }
    let message = match index.formulas.len() {
        0 => "This blueprint revision declares no formulas.".to_owned(),
        count => format!(
            "{count} valid {}: {}.",
            if count == 1 { "formula" } else { "formulas" },
            index
                .formulas
                .iter()
                .map(|formula| formula.target_code.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    };
    action_result(message, "info", false)
}

/// "Show formulas" in the Explorer toolbar: lists the revision's indexed
/// formulas. It names no rows, so it reads only the stored index.
fn list_action(input: ActionContext) -> Result<String, String> {
    let key = FormulaIndex::key(&input.blueprint_id, input.blueprint_version);
    let index = host::storage_get::<FormulaIndex>(&key)?.map(|(index, _)| index);
    let (message, severity) = match index {
        None => (
            "No formulas indexed yet; open a record of this revision first.".to_owned(),
            "warning",
        ),
        Some(FormulaIndex {
            error: Some(error), ..
        }) => (format!("Formulas are invalid: {error}"), "error"),
        Some(index) if index.formulas.is_empty() => (
            "This blueprint revision declares no formulas.".to_owned(),
            "info",
        ),
        Some(index) => (
            index
                .formulas
                .iter()
                .map(|formula| format!("{} = {}", formula.target_code, formula.expression))
                .collect::<Vec<_>>()
                .join(" · "),
            "info",
        ),
    };
    action_result(message, severity, false)
}
