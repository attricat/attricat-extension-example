//! Reference document generator for Attricat's interactive selection
//! operations (`catalog:host@1.5.0`).
//!
//! Each `process-batch` performs one small step and returns a checkpoint that
//! fully determines the next step. A replay with the same batch key therefore
//! produces byte-identical appends and the same stable annotation intent keys.
//! Rendering inputs are captured once per entity and never re-read, so source
//! edits made after capture cannot change a retried document.

wit_bindgen::generate!({ path: "../wit-interactive", world: "catalog-extension-operation" });

mod pdf;
mod zip;

use catalog::host::{artifacts, catalog_data, selection};
use exports::catalog::host::operations::{BatchResult, Guest, OperationRequest};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const OPERATION: &str = "generate-documents";
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
enum Template {
    Summary,
    Label,
}

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
    template: Template,
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
    entity_id: String,
    position: u64,
    title: Option<String>,
    lines: Vec<String>,
    fingerprint: String,
    read_at: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct EntityResult {
    entity_id: String,
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
    results: Vec<EntityResult>,
    zip: zip::ZipState,
    pdf: pdf::StreamState,
    combined_artifact: Option<String>,
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

fn capture(member: &Value, read_at: &str) -> Captured {
    let mut title = None;
    let mut first_string = None;
    let mut lines = Vec::new();
    let mut bytes = 0;
    if let Some(values) = member["values"].as_object() {
        for (code, entry) in values {
            let raw = entry.get("value").unwrap_or(entry);
            let Some(text) = scalar_text(raw) else {
                continue;
            };
            if raw.is_string() {
                if title.is_none() && matches!(code.as_str(), "title" | "name") {
                    title = Some(truncate(&text, MAX_LINE_CHARS));
                }
                first_string.get_or_insert_with(|| truncate(&text, MAX_LINE_CHARS));
            }
            let line = truncate(&format!("{code}: {text}"), MAX_LINE_CHARS);
            if lines.len() >= MAX_LINES || bytes + line.len() > MAX_CAPTURE_BYTES {
                break;
            }
            bytes += line.len();
            lines.push(line);
        }
    }
    let title = title.or(first_string);
    let entity_id = member["entity_id"].as_str().unwrap_or_default().to_owned();
    let canonical = json!({
        "entity_id": entity_id,
        "updated_at": member["updated_at"],
        "title": title,
        "lines": lines,
    });
    Captured {
        fingerprint: format!("{:x}", Sha256::digest(canonical.to_string().as_bytes())),
        entity_id,
        position: member["position"].as_u64().unwrap_or_default(),
        title,
        lines,
        read_at: read_at.to_owned(),
    }
}

/// Template compatibility is validated per entity; failures are reported,
/// never fatal to the run.
fn validate(template: Template, captured: &Captured) -> Result<(), String> {
    match template {
        Template::Label if captured.title.is_none() => {
            Err("the label template requires a title or name value".into())
        }
        Template::Summary if captured.lines.is_empty() => {
            Err("the summary template requires at least one saved value".into())
        }
        _ => Ok(()),
    }
}

fn page_text(template: Template, captured: &Captured) -> (String, Vec<String>) {
    let title = captured
        .title
        .clone()
        .unwrap_or_else(|| format!("Entity {}", captured.entity_id));
    let lines = match template {
        Template::Summary => captured.lines.clone(),
        Template::Label => vec![
            format!("Entity: {}", captured.entity_id),
            format!("Fingerprint: {}", &captured.fingerprint[..16]),
        ],
    };
    (title, lines)
}

fn document_name(position: u64) -> String {
    format!("document-{}.pdf", position + 1)
}

/// Applies the generated-document annotation. A rejected intent is recorded
/// as bookkeeping failure rather than reported as success.
fn annotate(
    request: &OperationRequest,
    input: &Input,
    results: &mut [EntityResult],
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
                "intent_key": format!("doc-{}-{}", request.run_id, result.entity_id),
                "entity_id": result.entity_id,
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
    let outcomes = catalog_data::batch(&batch.to_string())
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
    let count = |predicate: &dyn Fn(&EntityResult) -> bool| {
        checkpoint
            .results
            .iter()
            .filter(|item| predicate(item))
            .count()
    };
    let annotation_failed =
        |item: &EntityResult| item.annotation.as_deref() == Some("annotation_failed");
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
            if let Some(member) = page["entities"].get(0) {
                let entity_id = member["entity_id"].as_str().unwrap_or_default().to_owned();
                let position = member["position"].as_u64().unwrap_or_default();
                match member["status"].as_str() {
                    Some("available") => {
                        let captured = capture(member, read_at);
                        match validate(input.template, &captured) {
                            Ok(()) => {
                                checkpoint.pending = Some(captured);
                                checkpoint.phase = Phase::Render;
                            }
                            Err(reason) => checkpoint.results.push(EntityResult {
                                entity_id,
                                position,
                                status: "failed".into(),
                                reason: Some(reason),
                                fingerprint: Some(captured.fingerprint),
                                ..Default::default()
                            }),
                        }
                    }
                    status => checkpoint.results.push(EntityResult {
                        entity_id,
                        position,
                        status: "skipped".into(),
                        reason: Some(format!("entity is {}", status.unwrap_or("unavailable"))),
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
            let (title, lines) = page_text(input.template, &captured);
            let name = document_name(captured.position);
            let mut result = EntityResult {
                entity_id: captured.entity_id.clone(),
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
            // Only entities included in the finalized combined output.
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

struct Component;

impl Guest for Component {
    fn prepare(request: OperationRequest) -> Result<String, String> {
        if request.operation_id != OPERATION {
            return Err("unsupported operation".into());
        }
        let input: Input = serde_json::from_str(&request.input).map_err(|_| "invalid input")?;
        if input.template_version != 1 {
            return Err("unsupported template version".into());
        }
        Ok("validated document request".into())
    }

    fn start(_: OperationRequest) -> Result<String, String> {
        Ok("started document generation".into())
    }

    fn process_batch(request: OperationRequest) -> Result<BatchResult, String> {
        let input: Input = serde_json::from_str(&request.input).map_err(|_| "invalid input")?;
        let mut checkpoint: Checkpoint =
            serde_json::from_str(&request.checkpoint).map_err(|_| "invalid checkpoint")?;
        let done = step(&request, &input, &mut checkpoint)?;
        Ok(BatchResult {
            progress: progress(&checkpoint),
            checkpoint: serde_json::to_string(&checkpoint).map_err(|_| "checkpoint")?,
            done,
        })
    }

    fn checkpoint(_: OperationRequest) -> Result<(), String> {
        Ok(())
    }

    fn finish(_: OperationRequest) -> Result<(), String> {
        Ok(())
    }

    fn cancel(_: OperationRequest) -> Result<(), String> {
        Ok(())
    }
}

export!(Component);
