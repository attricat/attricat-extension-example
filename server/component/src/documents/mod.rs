//! The interactive `generate-documents` operation: one PDF per selected
//! record, a stored ZIP of them, or one combined PDF, started from the record
//! preview or Explorer actions through the host action dialog.
//!
//! Each `process-batch` performs one small step and returns a checkpoint that
//! fully determines the next step. A replay with the same batch key therefore
//! produces byte-identical appends and the same stable annotation intent keys.
//! Rendering inputs are captured once per record and never re-read, so source
//! edits made after capture cannot change a retried document.

mod pdf;
pub mod templates;
mod zip;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::attricat::host::outcomes::{Failure, Rejection};
use crate::attricat::host::{artifacts, attricat_data, selection};
use crate::exports::attricat::host::deferrable_operations::{BatchOutcome, OperationRequest};
use templates::{DocumentTemplate, Layout};

pub const OPERATION: &str = "generate-documents";
const MAX_LINES: usize = 40;
const MAX_LINE_CHARS: usize = 120;
const MAX_CAPTURE_BYTES: usize = 4 * 1024;
const MAX_REPORT_BYTES: usize = 64 * 1024;
const ZIP_OUTPUT: &str = "documents.zip";
const COMBINED_OUTPUT: &str = "documents.pdf";
const REPORT_OUTPUT: &str = "report.json";
const GENERATED_TAG: &str = "document-generated";

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Output {
    Individual,
    Zip,
    Combined,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    /// A template ID from the Document templates route.
    template: String,
    /// The template version the dialog showed; a run of any other version is
    /// rejected, so an edit made meanwhile never changes what was requested.
    template_version: u32,
    output: Output,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    #[default]
    Capture,
    Render,
    Finalize,
    Annotate,
    Report,
}

/// Rendering input captured once from the run's selection.
#[derive(Clone, Deserialize, Serialize)]
struct Captured {
    record_id: String,
    position: u64,
    title: Option<String>,
    lines: Vec<String>,
    fingerprint: String,
    read_at: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct RecordResult {
    record_id: String,
    position: u64,
    /// `rendered`, `failed` or `skipped`.
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    artifact_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    read_at: Option<String>,
    /// `applied`, `already_applied`, `annotation_failed`, or absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    annotation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    annotation_error: Option<String>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct Checkpoint {
    phase: Phase,
    cursor: String,
    exhausted: bool,
    total: u64,
    pending: Option<Captured>,
    results: Vec<RecordResult>,
    zip: zip::ZipState,
    pdf: pdf::StreamState,
    combined_artifact: Option<String>,
    /// The requested template, snapshotted by the first batch.
    template: Option<DocumentTemplate>,
}

fn parse(value: &str, label: &str) -> Result<Value, String> {
    serde_json::from_str(value).map_err(|_| format!("host returned invalid {label}"))
}

/// Resolved values have the shape `{code: {"value": ..., "source_context": ...}}`.
fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_owned()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(scalar_text).collect();
            (!parts.is_empty()).then(|| parts.join(", "))
        }
        _ => None,
    }
}

fn truncate(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// Captures the title and the template's printed values. A summary with an
/// attribute list prints those codes in its order; otherwise every saved value.
fn capture(member: &Value, read_at: &str, attributes: &[String]) -> Captured {
    let mut title = None;
    let mut first_string = None;
    let mut lines = Vec::new();
    let mut bytes = 0;
    if let Some(values) = member["values"].as_object() {
        let selected: Vec<(&String, &Value)> = if attributes.is_empty() {
            values.iter().collect()
        } else {
            attributes
                .iter()
                .filter_map(|code| values.get_key_value(code))
                .collect()
        };
        for (code, entry) in values {
            let raw = entry.get("value").unwrap_or(entry);
            if let (Value::String(_), Some(text)) = (raw, scalar_text(raw)) {
                if title.is_none() && matches!(code.as_str(), "title" | "name") {
                    title = Some(truncate(&text, MAX_LINE_CHARS));
                }
                first_string.get_or_insert_with(|| truncate(&text, MAX_LINE_CHARS));
            }
        }
        for (code, entry) in selected {
            let raw = entry.get("value").unwrap_or(entry);
            let Some(text) = scalar_text(raw) else {
                continue;
            };
            let line = truncate(&format!("{code}: {text}"), MAX_LINE_CHARS);
            if lines.len() >= MAX_LINES || bytes + line.len() > MAX_CAPTURE_BYTES {
                break;
            }
            bytes += line.len();
            lines.push(line);
        }
    }
    let title = title.or(first_string);
    let record_id = member["record_id"].as_str().unwrap_or_default().to_owned();
    let canonical = json!({
        "record_id": record_id,
        "updated_at": member["updated_at"],
        "title": title,
        "lines": lines,
    });
    Captured {
        fingerprint: format!("{:x}", Sha256::digest(canonical.to_string().as_bytes())),
        record_id,
        position: member["position"].as_u64().unwrap_or_default(),
        title,
        lines,
        read_at: read_at.to_owned(),
    }
}

/// Template compatibility is validated per record; failures are reported,
/// never fatal to the run.
fn validate(template: &DocumentTemplate, captured: &Captured) -> Result<(), String> {
    match template.layout {
        Layout::Label if captured.title.is_none() => Err(format!(
            "the `{}` label template requires a title or name value",
            template.id
        )),
        Layout::Summary if captured.lines.is_empty() => Err(format!(
            "the `{}` summary template found none of its values saved",
            template.id
        )),
        _ => Ok(()),
    }
}

fn page_text(template: &DocumentTemplate, captured: &Captured) -> (String, Vec<String>) {
    let title = captured
        .title
        .clone()
        .unwrap_or_else(|| format!("Record {}", captured.record_id));
    let mut lines = Vec::new();
    if !template.heading.is_empty() {
        lines.extend([template.heading.clone(), String::new()]);
    }
    match template.layout {
        Layout::Summary => lines.extend(captured.lines.iter().cloned()),
        Layout::Label => lines.extend([
            format!("Record: {}", captured.record_id),
            format!("Fingerprint: {}", &captured.fingerprint[..16]),
        ]),
    }
    (title, lines)
}

/// Snapshots the requested template version from storage.
fn load_template(input: &Input) -> Result<DocumentTemplate, Failure> {
    let rejected = |code: &str, message: String| {
        Failure::Rejected(Rejection {
            code: code.into(),
            message,
            record_id: None,
            connection: None,
        })
    };
    let (templates, _) = templates::load()?;
    let template = templates
        .into_iter()
        .find(|template| template.id == input.template)
        .ok_or_else(|| {
            rejected(
                "template_missing",
                format!("Template `{}` no longer exists.", input.template),
            )
        })?;
    if template.version != input.template_version {
        return Err(rejected(
            "template_changed",
            format!(
                "Template `{}` is at version {}, not {}; start the run again.",
                template.id, template.version, input.template_version
            ),
        ));
    }
    Ok(template)
}

fn document_name(position: u64) -> String {
    format!("document-{}.pdf", position + 1)
}

/// Applies the generated-document annotation. A rejected intent is recorded
/// as bookkeeping failure rather than reported as success.
fn annotate(
    request: &OperationRequest,
    input: &Input,
    results: &mut [RecordResult],
    indexes: &[usize],
    artifact_id: &str,
) {
    if indexes.is_empty() {
        return;
    }
    let intents: Vec<Value> = indexes
        .iter()
        .map(|index| {
            let result = &results[*index];
            json!({
                "kind": "annotate",
                "intent_key": format!("doc-{}-{}", request.run_id, result.record_id),
                "record_id": result.record_id,
                "add_tags": [GENERATED_TAG],
                "set_metadata": {"last_document": {
                    "template": input.template,
                    "template_version": input.template_version,
                    "output": input.output,
                    "run_id": request.run_id,
                    "artifact_id": artifact_id,
                    "fingerprint": result.fingerprint,
                    "generated_at": result.read_at,
                }}
            })
        })
        .collect();
    let batch = json!({"operation": "batch", "batch": {
        "batch_key": request.batch_key,
        "dry_run": false,
        "intents": intents,
    }});
    let outcomes = attricat_data::batch(&batch.to_string())
        .and_then(|response| parse(&response, "annotation outcome"));
    for (offset, index) in indexes.iter().enumerate() {
        let result = &mut results[*index];
        match &outcomes {
            Ok(outcomes) => match outcomes[offset]["status"].as_str() {
                Some(status @ ("applied" | "already_applied")) => {
                    result.annotation = Some(status.to_owned());
                }
                _ => {
                    result.annotation = Some("annotation_failed".into());
                    result.annotation_error = outcomes[offset]["error"]
                        .as_str()
                        .map(|error| truncate(error, 200));
                }
            },
            Err(error) => {
                result.annotation = Some("annotation_failed".into());
                result.annotation_error = Some(truncate(error, 200));
            }
        }
    }
}

fn after_capture(checkpoint: &Checkpoint, output: Output) -> Phase {
    let rendered = checkpoint
        .results
        .iter()
        .any(|item| item.status == "rendered");
    if output != Output::Individual && rendered {
        Phase::Finalize
    } else {
        Phase::Report
    }
}

fn progress(checkpoint: &Checkpoint) -> String {
    let count = |predicate: &dyn Fn(&RecordResult) -> bool| {
        checkpoint
            .results
            .iter()
            .filter(|item| predicate(item))
            .count()
    };
    let annotation_failed =
        |item: &RecordResult| item.annotation.as_deref() == Some("annotation_failed");
    json!({
        "completed": checkpoint.results.len(),
        "total": checkpoint.total.max(1),
        "outcome": {
            "succeeded": count(&|item| item.status == "rendered" && !annotation_failed(item)),
            "failed": count(&|item| item.status == "failed" || annotation_failed(item)),
            "skipped": count(&|item| item.status == "skipped"),
        }
    })
    .to_string()
}

fn step(
    request: &OperationRequest,
    input: &Input,
    template: &DocumentTemplate,
    checkpoint: &mut Checkpoint,
) -> Result<bool, String> {
    match checkpoint.phase {
        Phase::Capture => {
            if checkpoint.total == 0 {
                let described = parse(&selection::describe()?, "selection")?;
                checkpoint.total = described["count"].as_u64().unwrap_or_default();
            }
            let page = parse(&selection::page(&checkpoint.cursor, 1)?, "selection page")?;
            let read_at = page["read_at"].as_str().unwrap_or_default();
            if let Some(member) = page["records"].get(0) {
                let record_id = member["record_id"].as_str().unwrap_or_default().to_owned();
                let position = member["position"].as_u64().unwrap_or_default();
                match member["status"].as_str() {
                    Some("available") => {
                        let captured = capture(member, read_at, &template.attributes);
                        match validate(template, &captured) {
                            Ok(()) => {
                                checkpoint.pending = Some(captured);
                                checkpoint.phase = Phase::Render;
                            }
                            Err(reason) => checkpoint.results.push(RecordResult {
                                record_id,
                                position,
                                status: "failed".into(),
                                reason: Some(reason),
                                fingerprint: Some(captured.fingerprint),
                                ..Default::default()
                            }),
                        }
                    }
                    status => checkpoint.results.push(RecordResult {
                        record_id,
                        position,
                        status: "skipped".into(),
                        reason: Some(format!("record is {}", status.unwrap_or("unavailable"))),
                        ..Default::default()
                    }),
                }
            }
            match page["next_cursor"].as_str() {
                Some(next) => checkpoint.cursor = next.to_owned(),
                None => checkpoint.exhausted = true,
            }
            if checkpoint.phase == Phase::Capture && checkpoint.exhausted {
                checkpoint.phase = after_capture(checkpoint, input.output);
            }
            Ok(false)
        }
        Phase::Render => {
            let captured = checkpoint
                .pending
                .take()
                .ok_or("render step has no captured input")?;
            let (title, lines) = page_text(template, &captured);
            let name = document_name(captured.position);
            let mut result = RecordResult {
                record_id: captured.record_id.clone(),
                position: captured.position,
                status: "rendered".into(),
                output_name: Some(name.clone()),
                fingerprint: Some(captured.fingerprint.clone()),
                read_at: Some(captured.read_at.clone()),
                ..Default::default()
            };
            match input.output {
                Output::Individual => {
                    let bytes = pdf::single_page(&title, &lines);
                    artifacts::append_output(&name, "application/pdf", &request.batch_key, &bytes)?;
                    let artifact_id = artifacts::finalize_output(&name)?;
                    result.artifact_id = Some(artifact_id.clone());
                    checkpoint.results.push(result);
                    let index = checkpoint.results.len() - 1;
                    annotate(
                        request,
                        input,
                        &mut checkpoint.results,
                        &[index],
                        &artifact_id,
                    );
                }
                Output::Zip => {
                    let document = pdf::single_page(&title, &lines);
                    let chunk = checkpoint.zip.entry(&name, &document)?;
                    artifacts::append_output(
                        ZIP_OUTPUT,
                        "application/zip",
                        &request.batch_key,
                        &chunk,
                    )?;
                    checkpoint.results.push(result);
                }
                Output::Combined => {
                    let chunk = checkpoint.pdf.page(&title, &lines);
                    artifacts::append_output(
                        COMBINED_OUTPUT,
                        "application/pdf",
                        &request.batch_key,
                        &chunk,
                    )?;
                    checkpoint.results.push(result);
                }
            }
            checkpoint.phase = if checkpoint.exhausted {
                after_capture(checkpoint, input.output)
            } else {
                Phase::Capture
            };
            Ok(false)
        }
        Phase::Finalize => {
            let (name, media_type, chunk) = match input.output {
                Output::Zip => (ZIP_OUTPUT, "application/zip", checkpoint.zip.finish()),
                _ => (COMBINED_OUTPUT, "application/pdf", checkpoint.pdf.finish()),
            };
            artifacts::append_output(name, media_type, &request.batch_key, &chunk)?;
            let artifact_id = artifacts::finalize_output(name)?;
            for result in checkpoint
                .results
                .iter_mut()
                .filter(|item| item.status == "rendered")
            {
                result.artifact_id = Some(artifact_id.clone());
                result.output_name = Some(name.to_owned());
            }
            checkpoint.combined_artifact = Some(artifact_id);
            checkpoint.phase = Phase::Annotate;
            Ok(false)
        }
        Phase::Annotate => {
            // Only records included in the finalized combined output.
            let indexes: Vec<usize> = checkpoint
                .results
                .iter()
                .enumerate()
                .filter(|(_, item)| item.status == "rendered")
                .map(|(index, _)| index)
                .collect();
            let artifact_id = checkpoint.combined_artifact.clone().unwrap_or_default();
            annotate(
                request,
                input,
                &mut checkpoint.results,
                &indexes,
                &artifact_id,
            );
            checkpoint.phase = Phase::Report;
            Ok(false)
        }
        Phase::Report => {
            let mut report = serde_json::to_vec_pretty(&json!({
                "operation": OPERATION,
                "run_id": request.run_id,
                "template": input.template,
                "template_version": input.template_version,
                "output": input.output,
                "results": checkpoint.results,
            }))
            .map_err(|_| "report could not be serialized")?;
            report.truncate(MAX_REPORT_BYTES);
            artifacts::append_output(
                REPORT_OUTPUT,
                "application/json",
                &request.batch_key,
                &report,
            )?;
            artifacts::finalize_output(REPORT_OUTPUT)?;
            Ok(true)
        }
    }
}

pub fn prepare(request: &OperationRequest) -> Result<String, String> {
    let input: Input = serde_json::from_str(&request.input).map_err(|_| "invalid input")?;
    load_template(&input).map_err(|failure| match failure {
        Failure::Rejected(rejection) => rejection.message,
        Failure::Retry(retry) => retry.message,
        Failure::Fault(message) => message,
    })?;
    Ok("validated document request".into())
}

/// An unreadable input or checkpoint cannot succeed on retry, so it is
/// rejected (the run dead-letters); host call failures are retried.
pub fn process_batch(request: &OperationRequest) -> Result<BatchOutcome, Failure> {
    let rejected = |code: &str, message: &str| {
        Failure::Rejected(Rejection {
            code: code.into(),
            message: message.into(),
            record_id: None,
            connection: None,
        })
    };
    let input: Input = serde_json::from_str(&request.input)
        .map_err(|_| rejected("invalid_input", "invalid input"))?;
    let mut checkpoint: Checkpoint = serde_json::from_str(&request.checkpoint)
        .map_err(|_| rejected("invalid_checkpoint", "invalid checkpoint"))?;
    let template = match checkpoint.template.clone() {
        Some(template) => template,
        None => {
            let template = load_template(&input)?;
            checkpoint.template = Some(template.clone());
            template
        }
    };
    let done = step(request, &input, &template, &mut checkpoint)?;
    Ok(BatchOutcome {
        progress: progress(&checkpoint),
        checkpoint: serde_json::to_string(&checkpoint)
            .map_err(|_| rejected("invalid_checkpoint", "checkpoint"))?,
        done,
        resume_after_ms: None,
    })
}
