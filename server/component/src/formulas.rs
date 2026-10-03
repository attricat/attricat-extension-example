//! Host-independent formula configuration: parsing the blueprint TOML, validating
//! it against the pinned revision, and evaluating against resolved values.

use std::collections::{BTreeMap, HashMap, HashSet};

use attricat_extension_example_formula_core::Formula;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const EXTENSION_ID: &str = "attricat-extension-example";

#[derive(Clone, Debug, Deserialize)]
pub struct BlueprintWithAttributes {
    pub blueprint: Blueprint,
    pub attributes: Vec<Attribute>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Blueprint {
    pub id: String,
    pub version: i64,
    pub definition: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Attribute {
    pub id: String,
    pub code: String,
    pub value_type: String,
}

/// One validated formula. Expressions reference attribute codes; dependencies
/// are kept both as stable IDs (event matching) and codes (resolved values).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct FormulaConfig {
    pub target_attribute_id: String,
    pub target_code: String,
    pub expression: String,
    pub dependencies: Vec<String>,
    pub dependency_codes: Vec<String>,
}

/// The per-revision formula index the server keeps in extension storage. Read
/// by panels and decorations (which cannot run commands or parse TOML) and by
/// interactive runs (which cannot read blueprints).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct FormulaIndex {
    pub blueprint_id: String,
    pub blueprint_version: i64,
    pub formulas: Vec<FormulaConfig>,
    pub error: Option<String>,
}

impl FormulaIndex {
    pub fn key(blueprint_id: &str, blueprint_version: i64) -> String {
        format!("formulas:{blueprint_id}:{blueprint_version}")
    }

    pub fn from_blueprint(blueprint: &BlueprintWithAttributes) -> Self {
        let (formulas, error) = match load_formulas(blueprint) {
            Ok(formulas) => (formulas, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        Self {
            blueprint_id: blueprint.blueprint.id.clone(),
            blueprint_version: blueprint.blueprint.version,
            formulas,
            error,
        }
    }
}

/// Display and rounding settings for a target attribute, stored as
/// attribute-scoped extension configuration.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AttributeSettings {
    #[serde(default)]
    pub precision: Option<u8>,
    #[serde(default)]
    pub unit: Option<String>,
}

impl AttributeSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.precision.is_some_and(|precision| precision > 6) {
            return Err("Precision must be between 0 and 6.".into());
        }
        if self
            .unit
            .as_deref()
            .is_some_and(|unit| unit.chars().count() > 12 || unit.trim() != unit)
        {
            return Err("Unit must be at most 12 characters without surrounding spaces.".into());
        }
        Ok(())
    }

    pub fn round(&self, value: f64) -> f64 {
        match self.precision {
            Some(precision) => {
                let factor = 10f64.powi(i32::from(precision));
                (value * factor).round() / factor
            }
            None => value,
        }
    }
}

/// Formulas are part of the immutable blueprint definition. The host keeps the
/// namespaced `[extensions.attricat-extension-example.formulas]` table, where
/// each key is a numeric target attribute code and each value its expression.
pub fn load_formulas(blueprint: &BlueprintWithAttributes) -> Result<Vec<FormulaConfig>, String> {
    let definition: toml::Value = blueprint
        .blueprint
        .definition
        .parse()
        .map_err(|error| format!("Invalid blueprint definition: {error}"))?;
    let Some(formulas) = definition
        .get("extensions")
        .and_then(|value| value.get(EXTENSION_ID))
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
        let mut dependencies = Vec::new();
        let mut dependency_codes = formula.dependencies();
        dependency_codes.sort();
        for code in &dependency_codes {
            let attribute = by_code
                .get(code.as_str())
                .ok_or_else(|| format!("Unknown attribute `{code}` in `{target_code}`."))?;
            require_numeric(attribute)?;
            dependencies.push(attribute.id.clone());
        }
        configs.push(FormulaConfig {
            target_attribute_id: target.id.clone(),
            target_code: target_code.clone(),
            expression: expression.to_owned(),
            dependencies,
            dependency_codes,
        });
    }
    normalize_formulas(configs)
}

fn normalize_formulas(mut formulas: Vec<FormulaConfig>) -> Result<Vec<FormulaConfig>, String> {
    let mut targets = HashSet::new();
    for formula in &mut formulas {
        if !targets.insert(formula.target_attribute_id.clone()) {
            return Err(format!(
                "Attribute `{}` has more than one formula.",
                formula.target_code
            ));
        }
        formula.dependencies.sort();
        formula.dependencies.dedup();
        formula.dependency_codes.dedup();
        if formula.dependencies.contains(&formula.target_attribute_id) {
            return Err(format!(
                "Formula `{}` cannot depend on itself.",
                formula.target_code
            ));
        }
    }
    reject_cycles(&formulas)?;
    formulas.sort_by(|left, right| left.target_code.cmp(&right.target_code));
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

fn require_numeric(attribute: &Attribute) -> Result<(), String> {
    if matches!(attribute.value_type.as_str(), "number" | "integer") {
        Ok(())
    } else {
        Err(format!("Attribute `{}` must be numeric.", attribute.code))
    }
}

/// `result` is `None` while any input has no value in the context; that is a
/// normal "waiting for inputs" state, not an error.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Evaluation {
    pub result: Option<f64>,
    pub inputs: BTreeMap<String, Option<f64>>,
    pub missing: Vec<String>,
}

/// Evaluates an expression against host-resolved values keyed by attribute
/// code (`{"price_net": {"value": 100, ...}}`). Context fallback has already
/// been applied by the host; the extension never resolves contexts itself.
pub fn evaluate(
    expression: &str,
    values: &Value,
    settings: &AttributeSettings,
) -> Result<Evaluation, String> {
    let formula = Formula::parse(expression).map_err(|error| error.to_string())?;
    let mut inputs = HashMap::new();
    for code in formula.dependencies() {
        inputs.insert(code.clone(), resolved_number(values, &code)?);
    }
    let mut missing: Vec<_> = inputs
        .iter()
        .filter(|(_, value)| value.is_none())
        .map(|(code, _)| code.clone())
        .collect();
    missing.sort();
    let result = if missing.is_empty() {
        let result = formula
            .evaluate(&inputs)
            .map_err(|error| error.to_string())?;
        if !result.is_finite() {
            return Err("Formula result is not a finite number.".into());
        }
        Some(settings.round(result))
    } else {
        None
    };
    Ok(Evaluation {
        result,
        inputs: inputs.into_iter().collect(),
        missing,
    })
}

/// Catalog stores decimals, so a value read back can differ from the f64 we
/// computed in the last bits (99.99 * 1.23 = 122.98769999999999 is stored as
/// 122.9877). Treat values within a relative 1e-9 as equal so unchanged
/// targets are not rewritten or reported as stale.
pub fn same_value(left: Option<f64>, right: Option<f64>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            (left - right).abs() <= 1e-9 * left.abs().max(right.abs()).max(1.0)
        }
        (None, None) => true,
        _ => false,
    }
}

pub fn resolved_number(values: &Value, code: &str) -> Result<Option<f64>, String> {
    match values.get(code).and_then(|entry| entry.get("value")) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_f64()
            .map(Some)
            .ok_or_else(|| format!("Attribute `{code}` must be a number.")),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn attribute(id: &str, code: &str, value_type: &str) -> Attribute {
        Attribute {
            id: id.into(),
            code: code.into(),
            value_type: value_type.into(),
        }
    }

    fn blueprint(definition: &str) -> BlueprintWithAttributes {
        BlueprintWithAttributes {
            blueprint: Blueprint {
                id: "bp".into(),
                version: 3,
                definition: definition.into(),
            },
            attributes: vec![
                attribute("gross-id", "gross", "number"),
                attribute("net-id", "net", "number"),
                attribute("vat-id", "vat", "number"),
                attribute("title-id", "title", "string"),
            ],
        }
    }

    #[test]
    fn loads_formulas_from_namespaced_blueprint_toml() {
        let formulas = load_formulas(&blueprint(
            "[extensions.attricat-extension-example.formulas]\ngross = \"net * (1 + vat)\"\n",
        ))
        .unwrap();
        assert_eq!(formulas.len(), 1);
        assert_eq!(formulas[0].target_attribute_id, "gross-id");
        assert_eq!(formulas[0].target_code, "gross");
        assert_eq!(formulas[0].dependencies, ["net-id", "vat-id"]);
        assert_eq!(formulas[0].dependency_codes, ["net", "vat"]);
    }

    #[test]
    fn blueprints_without_the_table_have_no_formulas() {
        assert!(load_formulas(&blueprint("")).unwrap().is_empty());
    }

    #[test]
    fn rejects_unknown_non_numeric_self_and_cyclic_formulas() {
        let table = "[extensions.attricat-extension-example.formulas]\n";
        for body in [
            "gross = \"missing * 2\"",
            "gross = \"title * 2\"",
            "title = \"net\"",
            "gross = \"gross + 1\"",
            "gross = \"net\"\nnet = \"gross\"",
        ] {
            assert!(
                load_formulas(&blueprint(&format!("{table}{body}\n"))).is_err(),
                "{body}"
            );
        }
    }

    #[test]
    fn the_index_records_load_errors_instead_of_failing() {
        let index = FormulaIndex::from_blueprint(&blueprint(
            "[extensions.attricat-extension-example.formulas]\ngross = \"(\"\n",
        ));
        assert!(index.formulas.is_empty());
        assert!(index.error.is_some());
        assert_eq!(FormulaIndex::key("bp", 3), "formulas:bp:3");
    }

    #[test]
    fn evaluates_resolved_values_and_rounds_with_settings() {
        let values = json!({"net": {"value": 100.0}, "vat": {"value": 0.2345}});
        let settings = AttributeSettings {
            precision: Some(2),
            unit: None,
        };
        let evaluation = evaluate("net * (1 + vat)", &values, &settings).unwrap();
        assert_eq!(evaluation.result, Some(123.45));
        assert_eq!(evaluation.inputs["net"], Some(100.0));
        assert!(evaluate("net * 2", &json!({"net": {"value": "x"}}), &settings).is_err());
        assert!(
            evaluate(
                "net / vat",
                &json!({"net": {"value": 1}, "vat": {"value": 0}}),
                &settings
            )
            .is_err()
        );
        let waiting = evaluate("net * vat", &json!({"net": {"value": 1}}), &settings).unwrap();
        assert_eq!(waiting.result, None);
        assert_eq!(waiting.missing, ["vat"]);
    }

    #[test]
    fn stored_decimals_compare_equal_to_computed_floats() {
        assert!(same_value(Some(122.9877), Some(99.99 * 1.23)));
        assert!(!same_value(Some(122.98), Some(122.99)));
        assert!(!same_value(None, Some(0.0)));
    }

    #[test]
    fn settings_are_bounded() {
        assert!(
            AttributeSettings {
                precision: Some(7),
                unit: None
            }
            .validate()
            .is_err()
        );
        assert!(
            AttributeSettings {
                precision: Some(2),
                unit: Some("EUR".into())
            }
            .validate()
            .is_ok()
        );
    }
}
