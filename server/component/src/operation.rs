//! The `operations` export: the interactive `recalculate-selection` operation
//! started from Explorer row/bulk actions through the host action dialog.
//!
//! Inside a run the component reads only its frozen selection (values already
//! resolved in the run's context) and writes only through `attricat-data.batch`;
//! the host rejects direct `api` catalog access. Formulas come from the stored
//! per-revision index because a run cannot read the blueprint.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::activity::{self, Entry};
use crate::attricat::host::{artifacts, attricat_data, selection};
use crate::exports::attricat::host::operations::{BatchResult, OperationRequest};
use crate::formulas::{self, AttributeSettings, FormulaIndex};
use crate::host::{self, decode, encode};

const REPORT: &str = "formula-report.csv";
const PAGE_SIZE: u32 = 10;
pub const CHECKED_TAG: &str = "formulas-checked";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    /// `write` updates stale targets; `report` only reports them.
    mode: String,
}

#[derive(Default, Deserialize, Serialize)]
struct Checkpoint {
    #[serde(default)]
    cursor: String,
    #[serde(default)]
    completed: u64,
    #[serde(default)]
    succeeded: u64,
    #[serde(default)]
    failed: u64,
    #[serde(default)]
    skipped: u64,
    #[serde(default)]
    updated: u64,
}

#[derive(Deserialize)]
struct Described {
    count: u64,
    blueprint_id: String,
    blueprint_version: i64,
}

#[derive(Deserialize)]
struct Page {
    records: Vec<Value>,
    context_id: Option<String>,
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct Outcome {
    intent_key: String,
    status: String,
    error: Option<String>,
}

/// One CSV row: record, target, previous resolved value, computed value, status.
#[derive(Debug, PartialEq)]
pub struct ReportRow {
    pub record_id: String,
    pub target: String,
    pub previous: Option<f64>,
    pub result: Option<f64>,
    pub status: String,
}

pub fn csv(rows: &[ReportRow], header: bool) -> String {
    let number = |value: Option<f64>| value.map(|value| value.to_string()).unwrap_or_default();
    let mut out = String::new();
    if header {
        out.push_str("record_id,target,previous,result,status\n");
    }
    for row in rows {
        out.push_str(&format!(
            "{},{},{},{},{}\n",
            row.record_id,
            row.target,
            number(row.previous),
            number(row.result),
            row.status
        ));
    }
    out
}

/// The host persists only a redacted summary of a failed batch, so the cause
/// is also written to the extension's host log (`logging.write`).
pub fn diagnostic(message: String) -> String {
    host::log("error", &format!("recalculate-selection failed: {message}"));
    message
}

pub fn prepare(request: OperationRequest) -> Result<String, String> {
    let input: Input = decode(&request.input, "operation input")?;
    if !matches!(input.mode.as_str(), "write" | "report") {
        return Err("mode must be `write` or `report`".into());
    }
    Ok("prepared".into())
}

pub fn process_batch(request: OperationRequest) -> Result<BatchResult, String> {
    let input: Input = decode(&request.input, "operation input")?;
    let write = input.mode == "write";
    let mut checkpoint: Checkpoint = decode(&request.checkpoint, "checkpoint")?;
    let described: Described = decode(&selection::describe()?, "selection description")?;
    let key = FormulaIndex::key(&described.blueprint_id, described.blueprint_version);
    let index = host::storage_get::<FormulaIndex>(&key)?
        .map(|(index, _)| index)
        .ok_or_else(|| {
            "No formula index for this blueprint revision yet; open one of its records first."
                .to_owned()
        })?;
    if let Some(error) = index.error {
        return Err(error);
    }
    let mut settings = BTreeMap::new();
    for formula in &index.formulas {
        settings.insert(
            formula.target_attribute_id.clone(),
            host::attribute_settings(
                &index.blueprint_id,
                index.blueprint_version,
                &formula.target_attribute_id,
            )?,
        );
    }

    let first = checkpoint.cursor.is_empty() && checkpoint.completed == 0;
    let page: Page = decode(
        &selection::page(&checkpoint.cursor, PAGE_SIZE)?,
        "selection page",
    )?;
    let mut rows = Vec::new();
    let mut intents = Vec::new();
    let mut record_rows: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for member in &page.records {
        let record_id = member["record_id"].as_str().unwrap_or_default().to_owned();
        checkpoint.completed += 1;
        if member["status"] != "available" {
            checkpoint.skipped += 1;
            rows.push(ReportRow {
                record_id,
                target: String::new(),
                previous: None,
                result: None,
                status: member["status"].as_str().unwrap_or("unavailable").into(),
            });
            continue;
        }
        let values = &member["values"];
        let mut stale = 0;
        for formula in &index.formulas {
            let previous = formulas::resolved_number(values, &formula.target_code)
                .ok()
                .flatten();
            let target_settings = settings
                .get(&formula.target_attribute_id)
                .cloned()
                .unwrap_or_else(AttributeSettings::default);
            let (result, status) =
                match formulas::evaluate(&formula.expression, values, &target_settings) {
                    Ok(evaluation) => match evaluation.result {
                        Some(result) if formulas::same_value(previous, Some(result)) => {
                            (Some(result), "current")
                        }
                        Some(result) => {
                            stale += 1;
                            (Some(result), if write { "updated" } else { "stale" })
                        }
                        None => (None, "missing-input"),
                    },
                    Err(_) => (None, "error"),
                };
            if write && status == "updated" {
                intents.push(json!({
                    "kind": "update",
                    "intent_key": format!("{record_id}:{}", formula.target_code),
                    "record_id": record_id,
                    "values": [{
                        "kind": "scalar",
                        "attribute_id": formula.target_attribute_id,
                        "context_id": page.context_id,
                        "value": result,
                    }],
                }));
            }
            record_rows
                .entry(record_id.clone())
                .or_default()
                .push(rows.len());
            rows.push(ReportRow {
                record_id: record_id.clone(),
                target: formula.target_code.clone(),
                previous,
                result,
                status: status.into(),
            });
        }
        intents.push(json!({
            "kind": "annotate",
            "intent_key": format!("{record_id}:annotate"),
            "record_id": record_id,
            "add_tags": [CHECKED_TAG],
            "set_metadata": {"last_run_id": request.run_id, "stale_targets": stale},
        }));
    }

    if !intents.is_empty() {
        let batch = json!({"operation": "batch", "batch": {
            "batch_key": request.batch_key,
            "dry_run": false,
            "intents": intents,
        }});
        let outcomes: Vec<Outcome> =
            decode(&attricat_data::batch(&batch.to_string())?, "batch outcomes")?;
        let mut failed_records = BTreeMap::new();
        for outcome in &outcomes {
            let record_id = outcome
                .intent_key
                .split(':')
                .next()
                .unwrap_or_default()
                .to_owned();
            if outcome.status == "rejected" {
                failed_records.insert(record_id, outcome.error.clone().unwrap_or_default());
            } else if outcome.intent_key.ends_with(":annotate") {
                continue;
            } else {
                checkpoint.updated += 1;
            }
        }
        for (record_id, row_indexes) in &record_rows {
            if let Some(error) = failed_records.get(record_id) {
                checkpoint.failed += 1;
                for index in row_indexes {
                    rows[*index].status = format!("rejected: {}", error.replace([',', '\n'], " "));
                }
            } else {
                checkpoint.succeeded += 1;
            }
        }
    } else {
        checkpoint.succeeded += record_rows.len() as u64;
    }

    artifacts::append_output(
        REPORT,
        "text/csv",
        &request.batch_key,
        csv(&rows, first).as_bytes(),
    )?;
    let done = page.next_cursor.is_none();
    if let Some(next) = page.next_cursor {
        checkpoint.cursor = next;
    } else {
        artifacts::finalize_output(REPORT)?;
        // One summary line per run; `result` carries the number of updated targets.
        activity::record(
            &[Entry {
                source: "run".into(),
                reference: Some(request.run_id.clone()),
                record_id: None,
                context_id: page.context_id.clone(),
                target_code: None,
                result: Some(checkpoint.updated as f64),
                written: checkpoint.updated > 0,
                error: None,
            }],
            0,
        );
    }
    Ok(BatchResult {
        checkpoint: encode(&checkpoint)?,
        progress: encode(&json!({
            "completed": checkpoint.completed,
            "total": described.count,
            "outcome": {
                "succeeded": checkpoint.succeeded,
                "failed": checkpoint.failed,
                "skipped": checkpoint.skipped,
            },
        }))?,
        done,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_writes_header_once_and_blank_missing_numbers() {
        let rows = [ReportRow {
            record_id: "e".into(),
            target: "gross".into(),
            previous: None,
            result: Some(123.0),
            status: "updated".into(),
        }];
        assert_eq!(
            csv(&rows, true),
            "record_id,target,previous,result,status\ne,gross,,123,updated\n"
        );
        assert_eq!(csv(&rows, false), "e,gross,,123,updated\n");
    }
}
