//! The `formula-preview` form assist: while someone enters a record, the host
//! calls `propose-formulas` when a watched formula input changes, and the
//! assist proposes each formula target the person has not edited, computed
//! from the form's unsaved values. The saved record is still recalculated by
//! the event handler; the proposal only shows the result before saving.
//!
//! Formulas come from the revision's stored [`FormulaIndex`], which the
//! extension keeps whenever it reads a record of that revision. For a
//! revision it has not seen yet, and for a record being edited it reads, the
//! index is refreshed from the record; otherwise the assist proposes nothing.

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::activity;
use crate::formulas::{self, AttributeSettings, FormulaConfig, FormulaIndex};
use crate::host::{self, decode, encode};

/// The context version this assist reads.
const CONTEXT_VERSION: u32 = 1;
/// The longest note the host accepts, in characters.
const MAX_NOTE_CHARS: usize = 140;

/// What the host sends a form assist's command.
#[derive(Deserialize)]
struct Context {
    version: u32,
    blueprint: Revision,
    record_id: Option<String>,
    /// Every watched and proposed field, `null` when empty.
    values: Map<String, Value>,
    /// Proposed fields the person has edited.
    #[serde(default)]
    edited: Vec<String>,
}

#[derive(Deserialize)]
struct Revision {
    id: String,
    version: i64,
}

/// One proposed formula target.
#[derive(Debug, PartialEq)]
struct Proposal {
    code: String,
    value: f64,
    note: String,
}

pub fn propose(payload: &str) -> Result<String, String> {
    let context: Context = decode(payload, "form assist context")?;
    if context.version != CONTEXT_VERSION {
        return Err(format!(
            "form assist context version {} is not supported",
            context.version
        ));
    }
    let index = match host::storage_get::<FormulaIndex>(&FormulaIndex::key(
        &context.blueprint.id,
        context.blueprint.version,
    ))? {
        Some((index, _)) => Some(index),
        None => match &context.record_id {
            Some(record_id) => Some(activity::refresh_index(
                &host::read_record(record_id)?.blueprint,
            )),
            None => None,
        },
    };
    let proposals = match index {
        Some(index) if index.error.is_none() => proposals(
            &index.formulas,
            &context.values,
            &context.edited,
            |formula| {
                host::attribute_settings(
                    &context.blueprint.id,
                    context.blueprint.version,
                    &formula.target_attribute_id,
                )
                .unwrap_or_default()
            },
        ),
        _ => Vec::new(),
    };
    encode(&json!({
        "proposals": proposals
            .into_iter()
            .map(|proposal| json!({
                "attribute_code": proposal.code,
                "value": proposal.value,
                "note": proposal.note,
            }))
            .collect::<Vec<_>>()
    }))
}

/// Evaluates `formulas`, in dependency order, against the form's `values`.
/// A target the context does not pass is not one of the assist's fields; one
/// the person edited keeps its value, which later formulas then read. A
/// formula missing an input proposes nothing.
fn proposals(
    formulas: &[FormulaConfig],
    values: &Map<String, Value>,
    edited: &[String],
    settings: impl Fn(&FormulaConfig) -> AttributeSettings,
) -> Vec<Proposal> {
    // `evaluate` reads host-resolved values: `{"code": {"value": …}}`.
    let mut resolved: Map<String, Value> = values
        .iter()
        .map(|(code, value)| (code.clone(), json!({ "value": value })))
        .collect();
    let mut proposals = Vec::new();
    for formula in formulas {
        if !values.contains_key(&formula.target_code) || edited.contains(&formula.target_code) {
            continue;
        }
        let Ok(evaluation) = formulas::evaluate(
            &formula.expression,
            &Value::Object(resolved.clone()),
            &settings(formula),
        ) else {
            continue;
        };
        let Some(value) = evaluation.result else {
            continue;
        };
        resolved.insert(formula.target_code.clone(), json!({ "value": value }));
        proposals.push(Proposal {
            code: formula.target_code.clone(),
            value,
            note: note(&formula.expression),
        });
    }
    proposals
}

/// "= <expression>", shortened to what the host shows.
fn note(expression: &str) -> String {
    let note = format!("= {expression}");
    if note.chars().count() <= MAX_NOTE_CHARS {
        return note;
    }
    let kept: String = note.chars().take(MAX_NOTE_CHARS - 1).collect();
    format!("{}…", kept.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn formula(target: &str, expression: &str) -> FormulaConfig {
        FormulaConfig {
            target_attribute_id: format!("{target}-id"),
            target_code: target.into(),
            expression: expression.into(),
            dependencies: Vec::new(),
            dependency_codes: Vec::new(),
        }
    }

    fn values(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn chained_formulas_propose_from_unsaved_values() {
        let formulas = [
            formula("price_gross", "price_net * (1 + vat_rate)"),
            formula("price_deposit", "price_gross * 0.2"),
        ];
        let proposed = proposals(
            &formulas,
            &values(
                json!({"price_net": 100, "vat_rate": 0.5, "price_gross": null, "price_deposit": null}),
            ),
            &[],
            |_| AttributeSettings::default(),
        );
        assert_eq!(
            proposed,
            [
                Proposal {
                    code: "price_gross".into(),
                    value: 150.0,
                    note: "= price_net * (1 + vat_rate)".into()
                },
                Proposal {
                    code: "price_deposit".into(),
                    value: 30.0,
                    note: "= price_gross * 0.2".into()
                },
            ]
        );
    }

    #[test]
    fn an_edited_target_is_kept_and_feeds_later_formulas() {
        let formulas = [
            formula("price_gross", "price_net * (1 + vat_rate)"),
            formula("price_deposit", "price_gross * 0.2"),
        ];
        let proposed = proposals(
            &formulas,
            &values(
                json!({"price_net": 100, "vat_rate": 0.5, "price_gross": 200, "price_deposit": null}),
            ),
            &["price_gross".to_owned()],
            |_| AttributeSettings::default(),
        );
        assert_eq!(proposed.len(), 1);
        assert_eq!(proposed[0].code, "price_deposit");
        assert_eq!(proposed[0].value, 40.0);
    }

    #[test]
    fn missing_inputs_and_fields_outside_the_assist_propose_nothing() {
        let formulas = [
            formula("price_gross", "price_net * (1 + vat_rate)"),
            formula("other", "price_net * 2"),
        ];
        assert!(
            proposals(
                &formulas,
                &values(json!({"price_net": 100, "vat_rate": null, "price_gross": null})),
                &[],
                |_| AttributeSettings::default(),
            )
            .is_empty()
        );
        assert!(note(&"x".repeat(200)).chars().count() <= MAX_NOTE_CHARS);
    }
}
