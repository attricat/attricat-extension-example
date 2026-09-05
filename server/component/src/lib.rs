//! Attricat v1.1 server component for context-aware computed numeric attributes.
//!
//! Formula text references blueprint attribute codes, while stored configuration
//! uses stable attribute IDs. Values are read through the host's resolved API
//! and writes target the requested context. The component has no storage or
//! context-fallback implementation of its own.

wit_bindgen::generate!({
    path: "wit",
    world: "catalog-extension",
});

use std::collections::{HashMap, HashSet};

use attricat_extension_example_formula_core::Formula;
use exports::catalog::host::handler::{CommandRequest, CommandResponse, Guest};
use serde::{Deserialize, Serialize};

use crate::catalog::host::api::{
    self, EntityReference, ReadRequest, ResolvedRead, ScalarWrite, WriteRequest,
};

struct FormulaExtension;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FormulaConfig {
    target_attribute_id: String,
    expression: String,
    dependencies: Vec<String>,
}

#[derive(Deserialize)]
struct BlueprintWithAttributes {
    blueprint: Blueprint,
    attributes: Vec<Attribute>,
}

#[derive(Deserialize)]
struct Blueprint {
    definition: String,
}

#[derive(Deserialize)]
struct Attribute {
    id: String,
    code: String,
    value_type: String,
}

#[derive(Deserialize)]
struct AttributeChanged {
    entity_id: String,
    facts: Vec<ChangedFact>,
}

#[derive(Deserialize)]
struct ChangedFact {
    attribute_id: String,
    context_id: Option<String>,
}

#[derive(Deserialize)]
struct RecalculateRequest {
    entity_id: String,
    context_id: String,
}

#[derive(Deserialize)]
struct PreviewRequest {
    entity_id: String,
    context_id: String,
    expression: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CalculationResult {
    target_attribute_id: String,
    result: f64,
    written: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewResult {
    result: f64,
    dependencies: Vec<String>,
    resolved_inputs: HashMap<String, Option<f64>>,
}

impl Guest for FormulaExtension {
    fn handle_event(event: api::Event) -> Result<(), String> {
        // Entity value writes are published by Catalog as entity.updated.v1;
        // its payload carries the changed attribute facts.
        if event.event_type != "entity.updated.v1" {
            return Ok(());
        }
        let changed: AttributeChanged = decode(&event.payload, "attribute change event")?;
        let entity = read_entity(&changed.entity_id)?;
        let formulas = load_formulas(&entity.blueprint)?;
        validate_runtime_formulas(&formulas, &entity.blueprint)?;

        let mut changed_by_context: HashMap<&str, HashSet<&str>> = HashMap::new();
        for fact in &changed.facts {
            if let Some(context_id) = fact.context_id.as_deref() {
                changed_by_context
                    .entry(context_id)
                    .or_default()
                    .insert(fact.attribute_id.as_str());
            }
        }
        for (context_id, changed_ids) in changed_by_context {
            // Only formulas whose dependencies changed in this same context are
            // evaluated. A derived write emits a separate downstream event.
            for formula in formulas.iter().filter(|formula| {
                formula
                    .dependencies
                    .iter()
                    .any(|dependency| changed_ids.contains(dependency.as_str()))
            }) {
                calculate_and_write(&changed.entity_id, context_id, &entity.blueprint, formula)?;
            }
        }
        Ok(())
    }

    fn handle_command(request: CommandRequest) -> Result<CommandResponse, String> {
        let payload = match request.handler.as_str() {
            "preview-formula" => {
                let input: PreviewRequest = decode(&request.payload, "preview request")?;
                let entity = read_entity(&input.entity_id)?;
                let formula =
                    Formula::parse(&input.expression).map_err(|error| error.to_string())?;
                let evaluation = evaluate(
                    &input.entity_id,
                    &input.context_id,
                    &entity.blueprint,
                    &formula,
                )?;
                json(&PreviewResult {
                    result: evaluation.result,
                    dependencies: formula.dependencies(),
                    resolved_inputs: evaluation.inputs,
                })?
            }
            "recalculate-formulas" => {
                let input: RecalculateRequest = decode(&request.payload, "recalculate request")?;
                let entity = read_entity(&input.entity_id)?;
                let formulas = load_formulas(&entity.blueprint)?;
                validate_runtime_formulas(&formulas, &entity.blueprint)?;
                let mut results = Vec::with_capacity(formulas.len());
                for formula in &formulas {
                    results.push(calculate_and_write(
                        &input.entity_id,
                        &input.context_id,
                        &entity.blueprint,
                        formula,
                    )?);
                }
                json(&results)?
            }
            _ => return Err("unknown command handler".into()),
        };
        Ok(CommandResponse { payload })
    }
}

fn read_entity(entity_id: &str) -> Result<ReadEntity, String> {
    let response = api::read(&ReadRequest::Entity(EntityReference {
        entity_id: entity_id.into(),
    }))?;
    Ok(ReadEntity {
        blueprint: decode(&response.blueprint, "blueprint")?,
    })
}

struct ReadEntity {
    blueprint: BlueprintWithAttributes,
}

/// Formulas are part of the immutable blueprint definition, not separate
/// attribute configuration. The host accepts namespaced extension TOML:
/// `[extensions.attricat-extension-example.formulas]`, where each key is the
/// target attribute code and each value is its expression.
fn load_formulas(blueprint: &BlueprintWithAttributes) -> Result<Vec<FormulaConfig>, String> {
    let definition: toml::Value = blueprint
        .blueprint
        .definition
        .parse()
        .map_err(|error| format!("invalid blueprint definition: {error}"))?;
    let Some(formulas) = definition
        .get("extensions")
        .and_then(|value| value.get("attricat-extension-example"))
        .and_then(|value| value.get("formulas"))
        .and_then(toml::Value::as_table)
    else {
        return Ok(Vec::new());
    };
    let by_code: HashMap<_, _> = blueprint
        .attributes
        .iter()
        .map(|attribute| (attribute.code.as_str(), attribute))
        .collect();
    let mut configs = Vec::with_capacity(formulas.len());
    for (target_code, expression) in formulas {
        let target = by_code
            .get(target_code.as_str())
            .ok_or_else(|| format!("Unknown formula target `{target_code}`."))?;
        require_numeric(target)?;
        let expression = expression
            .as_str()
            .ok_or_else(|| format!("Formula `{target_code}` must be a string."))?;
        let formula = Formula::parse(expression).map_err(|error| error.to_string())?;
        let dependencies = formula
            .dependencies()
            .iter()
            .map(|code| {
                let attribute = by_code
                    .get(code.as_str())
                    .ok_or_else(|| format!("Unknown attribute `{code}`."))?;
                require_numeric(attribute)?;
                Ok(attribute.id.clone())
            })
            .collect::<Result<Vec<_>, String>>()?;
        configs.push(FormulaConfig {
            target_attribute_id: target.id.clone(),
            expression: expression.to_owned(),
            dependencies,
        });
    }
    normalize_formulas(configs)
}

/// Normalize the durable representation and reject dependency cycles. The host
/// API currently cannot read an arbitrary blueprint revision during save, so
/// exact ID/type validation is performed authoritatively at execution time.
fn normalize_formulas(mut formulas: Vec<FormulaConfig>) -> Result<Vec<FormulaConfig>, String> {
    let mut targets = HashSet::new();
    for formula in &mut formulas {
        if formula.target_attribute_id.trim().is_empty() {
            return Err("Formula target attribute ID is required.".into());
        }
        if !targets.insert(formula.target_attribute_id.clone()) {
            return Err(format!(
                "Attribute `{}` has more than one formula.",
                formula.target_attribute_id
            ));
        }
        Formula::parse(&formula.expression).map_err(|error| error.to_string())?;
        formula.dependencies.retain(|id| !id.trim().is_empty());
        formula.dependencies.sort();
        formula.dependencies.dedup();
        if formula.dependencies.contains(&formula.target_attribute_id) {
            return Err("A formula cannot depend on its target attribute.".into());
        }
    }
    reject_cycles(&formulas)?;
    Ok(formulas)
}

fn reject_cycles(formulas: &[FormulaConfig]) -> Result<(), String> {
    let by_target: HashMap<_, _> = formulas
        .iter()
        .map(|formula| (formula.target_attribute_id.as_str(), formula))
        .collect();
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    for target in by_target.keys() {
        if has_cycle(target, &by_target, &mut visiting, &mut visited) {
            return Err("Formula dependencies contain a cycle.".into());
        }
    }
    Ok(())
}

fn has_cycle<'a>(
    target: &'a str,
    by_target: &HashMap<&'a str, &'a FormulaConfig>,
    visiting: &mut HashSet<&'a str>,
    visited: &mut HashSet<&'a str>,
) -> bool {
    if visited.contains(target) {
        return false;
    }
    if !visiting.insert(target) {
        return true;
    }
    let cyclic = by_target[target].dependencies.iter().any(|dependency| {
        by_target.contains_key(dependency.as_str())
            && has_cycle(dependency, by_target, visiting, visited)
    });
    visiting.remove(target);
    visited.insert(target);
    cyclic
}

fn validate_runtime_formulas(
    formulas: &[FormulaConfig],
    blueprint: &BlueprintWithAttributes,
) -> Result<(), String> {
    let by_id: HashMap<_, _> = blueprint
        .attributes
        .iter()
        .map(|attribute| (attribute.id.as_str(), attribute))
        .collect();
    let by_code: HashMap<_, _> = blueprint
        .attributes
        .iter()
        .map(|attribute| (attribute.code.as_str(), attribute))
        .collect();
    for config in formulas {
        let target = by_id
            .get(config.target_attribute_id.as_str())
            .ok_or_else(|| format!("Unknown target attribute `{}`.", config.target_attribute_id))?;
        require_numeric(target)?;
        let formula = Formula::parse(&config.expression).map_err(|error| error.to_string())?;
        let expected: Vec<_> = formula
            .dependencies()
            .iter()
            .map(|code| {
                let attribute = by_code
                    .get(code.as_str())
                    .ok_or_else(|| format!("Unknown attribute `{code}`."))?;
                require_numeric(attribute)?;
                Ok(attribute.id.to_owned())
            })
            .collect::<Result<_, String>>()?;
        if config.dependencies != expected {
            return Err(format!(
                "Formula dependencies for `{}` do not match its expression.",
                config.target_attribute_id
            ));
        }
    }
    Ok(())
}

fn require_numeric(attribute: &Attribute) -> Result<(), String> {
    if matches!(attribute.value_type.as_str(), "number" | "integer") {
        Ok(())
    } else {
        Err(format!("Attribute `{}` must be numeric.", attribute.code))
    }
}

fn calculate_and_write(
    entity_id: &str,
    context_id: &str,
    blueprint: &BlueprintWithAttributes,
    config: &FormulaConfig,
) -> Result<CalculationResult, String> {
    let formula = Formula::parse(&config.expression).map_err(|error| error.to_string())?;
    let evaluation = evaluate(entity_id, context_id, blueprint, &formula)?;
    let current = read_direct_value(entity_id, context_id, &config.target_attribute_id)?;
    if current == Some(evaluation.result) {
        return Ok(CalculationResult {
            target_attribute_id: config.target_attribute_id.clone(),
            result: evaluation.result,
            written: false,
        });
    }
    api::write(&WriteRequest {
        entity_id: entity_id.into(),
        values: vec![ScalarWrite {
            attribute_id: Some(config.target_attribute_id.clone()),
            attribute_code: None,
            context_id: context_id.into(),
            value: json(&evaluation.result)?,
        }],
    })?;
    Ok(CalculationResult {
        target_attribute_id: config.target_attribute_id.clone(),
        result: evaluation.result,
        written: true,
    })
}

struct Evaluation {
    result: f64,
    inputs: HashMap<String, Option<f64>>,
}

fn evaluate(
    entity_id: &str,
    context_id: &str,
    blueprint: &BlueprintWithAttributes,
    formula: &Formula,
) -> Result<Evaluation, String> {
    let response = api::read(&ReadRequest::Resolved(ResolvedRead {
        entity_id: entity_id.into(),
        context_id: context_id.into(),
    }))?;
    let resolved = response
        .resolved_values
        .ok_or_else(|| "host did not return resolved values".to_owned())?;
    let values: serde_json::Value = decode(&resolved, "resolved values")?;
    let by_code: HashMap<_, _> = blueprint
        .attributes
        .iter()
        .map(|attribute| (attribute.code.as_str(), attribute))
        .collect();
    let mut inputs = HashMap::new();
    for code in formula.dependencies() {
        let attribute = by_code
            .get(code.as_str())
            .ok_or_else(|| format!("Unknown attribute `{code}`."))?;
        require_numeric(attribute)?;
        inputs.insert(code.clone(), resolved_number(&values, &code)?);
    }
    let result = formula
        .evaluate(&inputs)
        .map_err(|error| error.to_string())?;
    Ok(Evaluation { result, inputs })
}

/// Read the direct value in the requested context, not a fallback-resolved
/// value. A target inherited from a parent context must still receive a direct
/// derived value in this context.
fn read_direct_value(
    entity_id: &str,
    context_id: &str,
    attribute_id: &str,
) -> Result<Option<f64>, String> {
    let response = api::read(&ReadRequest::Values(EntityReference {
        entity_id: entity_id.into(),
    }))?;
    let values: Vec<serde_json::Value> = decode(&response.direct_values, "direct values")?;
    let Some(value) = values
        .iter()
        .find(|entry| {
            entry
                .get("attribute_id")
                .and_then(serde_json::Value::as_str)
                == Some(attribute_id)
                && entry.get("context_id").and_then(serde_json::Value::as_str) == Some(context_id)
                && entry.get("active").and_then(serde_json::Value::as_bool) != Some(false)
        })
        .and_then(|entry| entry.get("value"))
    else {
        return Ok(None);
    };
    value
        .as_f64()
        .map(Some)
        .ok_or_else(|| format!("Attribute `{attribute_id}` must be a number."))
}

fn resolved_number(values: &serde_json::Value, code: &str) -> Result<Option<f64>, String> {
    let Some(value) = values
        .get("values")
        .and_then(|values| values.get(code))
        .and_then(|entry| entry.get("value"))
    else {
        return Ok(None);
    };
    value
        .as_f64()
        .map(Some)
        .ok_or_else(|| format!("Attribute `{code}` must be a number."))
}

fn decode<T: for<'a> Deserialize<'a>>(value: &str, label: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|_| format!("invalid {label}"))
}

fn json(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|_| "response serialization failed".to_owned())
}

export!(FormulaExtension);

#[cfg(test)]
mod tests {
    use super::*;

    fn formula(target: &str, dependencies: &[&str]) -> FormulaConfig {
        FormulaConfig {
            target_attribute_id: target.into(),
            expression: "source + 1".into(),
            dependencies: dependencies.iter().map(|value| (*value).into()).collect(),
        }
    }

    #[test]
    fn normalizes_dependency_ids_and_rejects_duplicate_targets() {
        let normalized =
            normalize_formulas(vec![formula("target", &["second", "first", "second"])]).unwrap();
        assert_eq!(normalized[0].dependencies, ["first", "second"]);
        assert!(normalize_formulas(vec![formula("target", &[]), formula("target", &[])]).is_err());
    }

    #[test]
    fn rejects_transitive_cycles() {
        let mut first = formula("first", &["second"]);
        first.expression = "source".into();
        let mut second = formula("second", &["third"]);
        second.expression = "source".into();
        let mut third = formula("third", &["first"]);
        third.expression = "source".into();
        assert!(normalize_formulas(vec![first, second, third]).is_err());
    }

    #[test]
    fn loads_formulas_from_namespaced_blueprint_toml() {
        let blueprint = BlueprintWithAttributes {
            blueprint: Blueprint {
                definition: r#"
[extensions.attricat-extension-example.formulas]
gross = "net * 1.23"
"#
                .into(),
            },
            attributes: vec![
                Attribute {
                    id: "gross-id".into(),
                    code: "gross".into(),
                    value_type: "number".into(),
                },
                Attribute {
                    id: "net-id".into(),
                    code: "net".into(),
                    value_type: "number".into(),
                },
            ],
        };
        let formulas = load_formulas(&blueprint).unwrap();
        assert_eq!(formulas.len(), 1);
        assert_eq!(formulas[0].target_attribute_id, "gross-id");
        assert_eq!(formulas[0].dependencies, ["net-id"]);
    }

    #[test]
    fn runtime_validation_maps_codes_to_stable_ids_and_requires_numeric_attributes() {
        let blueprint = BlueprintWithAttributes {
            blueprint: Blueprint {
                definition: "".into(),
            },
            attributes: vec![
                Attribute {
                    id: "target".into(),
                    code: "gross".into(),
                    value_type: "number".into(),
                },
                Attribute {
                    id: "source".into(),
                    code: "source".into(),
                    value_type: "number".into(),
                },
            ],
        };
        assert!(validate_runtime_formulas(&[formula("target", &["source"])], &blueprint).is_ok());
        assert!(validate_runtime_formulas(&[formula("target", &["wrong"])], &blueprint).is_err());
    }
}
