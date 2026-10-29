//! Document templates, managed from the Document templates route and kept in
//! extension storage under one key. A template is text: a title line and a
//! body in which `{{ attribute_code }}` marks are replaced with the record's
//! saved values when a document is rendered. Until the first save the
//! built-in `summary` and `label` templates apply.
//!
//! Every save bumps the template's version; a run names the version it was
//! started with and snapshots that template, so later edits never change a
//! started or retried run.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::host::{self, decode, encode};

pub const TEMPLATES_KEY: &str = "document-templates";
const MAX_TEMPLATES: usize = 20;
const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 4000;
const MAX_BODY_LINES: usize = 80;
const MAX_PLACEHOLDERS: usize = 40;

/// The record's ID.
pub const RECORD_ID: &str = "record.id";
/// The first 16 hex digits of the captured content's SHA-256 fingerprint.
pub const RECORD_FINGERPRINT: &str = "record.fingerprint";
/// Every saved value, one `code: value` line each.
pub const RECORD_VALUES: &str = "record.values";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DocumentTemplate {
    pub id: String,
    pub name: String,
    /// The page title; when every mark in it is empty the record ID is used.
    pub title: String,
    pub body: String,
    #[serde(default = "first_version")]
    pub version: u32,
    #[serde(default)]
    pub builtin: bool,
}

fn first_version() -> u32 {
    1
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Templates {
    pub templates: Vec<DocumentTemplate>,
}

pub fn builtins() -> Vec<DocumentTemplate> {
    vec![
        DocumentTemplate {
            id: "summary".into(),
            name: "Summary sheet".into(),
            title: "{{ title }}".into(),
            body: "{{ record.values }}".into(),
            version: 1,
            builtin: true,
        },
        DocumentTemplate {
            id: "label".into(),
            name: "Product label".into(),
            title: "{{ title }}".into(),
            body: "Record: {{ record.id }}\nFingerprint: {{ record.fingerprint }}".into(),
            version: 1,
            builtin: true,
        },
    ]
}

/// One piece of parsed template text.
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Text(String),
    /// A `{{ name }}` mark: an attribute code or a `record.*` name.
    Mark(String),
}

fn valid_code(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Splits text into literal text and `{{ name }}` marks. A mark names an
/// attribute code (lowercase letters, digits, `_`, `-`) or one of the
/// `record.*` names; anything else, or an unclosed `{{`, is an error.
pub fn parse(text: &str) -> Result<Vec<Part>, String> {
    let mut parts = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        if start > 0 {
            parts.push(Part::Text(rest[..start].to_owned()));
        }
        let after = &rest[start + 2..];
        let end = after
            .find("}}")
            .ok_or_else(|| "A `{{` mark is not closed with `}}`.".to_owned())?;
        let name = after[..end].trim();
        if !(valid_code(name) || matches!(name, RECORD_ID | RECORD_FINGERPRINT | RECORD_VALUES)) {
            return Err(format!(
                "`{{{{ {name} }}}}` is not an attribute code or a record.* mark."
            ));
        }
        parts.push(Part::Mark(name.to_owned()));
        rest = &after[end + 2..];
    }
    if !rest.is_empty() {
        parts.push(Part::Text(rest.to_owned()));
    }
    Ok(parts)
}

impl DocumentTemplate {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=32).contains(&self.id.len())
            || !self
                .id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        {
            return Err("Template IDs are 1-32 lowercase letters, digits, `-` or `_`.".into());
        }
        if self.name.trim().is_empty() || self.name.chars().count() > 60 {
            return Err("Template names are 1-60 characters.".into());
        }
        if self.title.contains('\n') || self.title.chars().count() > MAX_TITLE_CHARS {
            return Err(format!(
                "The title is one line of at most {MAX_TITLE_CHARS} characters."
            ));
        }
        if self.body.trim().is_empty()
            || self.body.chars().count() > MAX_BODY_CHARS
            || self.body.lines().count() > MAX_BODY_LINES
        {
            return Err(format!(
                "The body is 1-{MAX_BODY_CHARS} characters in at most {MAX_BODY_LINES} lines."
            ));
        }
        let title = parse(&self.title).map_err(|error| format!("Title: {error}"))?;
        if title.contains(&Part::Mark(RECORD_VALUES.into())) {
            return Err(
                "Title: `{{ record.values }}` spans several lines; use it in the body.".into(),
            );
        }
        let body = parse(&self.body).map_err(|error| format!("Body: {error}"))?;
        let marks = title
            .iter()
            .chain(&body)
            .filter(|part| matches!(part, Part::Mark(_)));
        if marks.count() > MAX_PLACEHOLDERS {
            return Err(format!("A template has at most {MAX_PLACEHOLDERS} marks."));
        }
        Ok(())
    }

    /// The attribute codes the template's marks name, and whether it prints
    /// every saved value.
    pub fn references(&self) -> (BTreeSet<String>, bool) {
        let mut codes = BTreeSet::new();
        let mut all = false;
        for part in parse(&self.title)
            .unwrap_or_default()
            .into_iter()
            .chain(parse(&self.body).unwrap_or_default())
        {
            match part {
                Part::Mark(name) if name == RECORD_VALUES => all = true,
                Part::Mark(name) if !name.starts_with("record.") => {
                    codes.insert(name);
                }
                _ => {}
            }
        }
        (codes, all)
    }
}

/// What a record contributes to rendering.
pub trait Values {
    fn value(&self, code: &str) -> Option<&str>;
    fn record_id(&self) -> &str;
    fn fingerprint(&self) -> &str;
    /// Every saved value as `code: value` lines.
    fn all_lines(&self) -> &[String];
}

/// Replaces marks with values. A mark without a saved value renders as
/// `missing` and its code is collected in the returned list.
pub fn render(text: &str, values: &impl Values, missing: &str) -> (String, Vec<String>) {
    let mut out = String::new();
    let mut absent = Vec::new();
    for part in parse(text).unwrap_or_default() {
        match part {
            Part::Text(text) => out.push_str(&text),
            Part::Mark(name) => match name.as_str() {
                RECORD_ID => out.push_str(values.record_id()),
                RECORD_FINGERPRINT => {
                    out.push_str(&values.fingerprint()[..16.min(values.fingerprint().len())])
                }
                RECORD_VALUES => out.push_str(&values.all_lines().join("\n")),
                code => match values.value(code) {
                    Some(value) => out.push_str(value),
                    None => {
                        out.push_str(missing);
                        absent.push(code.to_owned());
                    }
                },
            },
        }
    }
    (out, absent)
}

/// The stored templates with their storage revision, or the built-ins.
pub fn load() -> Result<(Vec<DocumentTemplate>, Option<i64>), String> {
    Ok(match host::storage_get::<Templates>(TEMPLATES_KEY)? {
        Some((stored, revision)) => (stored.templates, Some(revision)),
        None => (builtins(), None),
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveRequest {
    template: DocumentTemplate,
    /// The version the editor loaded; `null` creates a new template.
    expected_version: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteRequest {
    id: String,
}

/// `list-templates`, `save-template` and `delete-template`.
pub fn handle_command(handler: &str, payload: &str) -> Result<String, String> {
    let (mut templates, revision) = load()?;
    match handler {
        "list-templates" => {}
        "save-template" => {
            let SaveRequest {
                mut template,
                expected_version,
            } = decode(payload, "template request")?;
            template.validate()?;
            let count = templates.len();
            match (
                templates.iter_mut().find(|item| item.id == template.id),
                expected_version,
            ) {
                (Some(existing), Some(expected)) if existing.version == expected => {
                    template.version = expected + 1;
                    template.builtin = existing.builtin;
                    *existing = template;
                }
                (Some(_), Some(_)) => {
                    return Err(
                        "The template changed since you opened it; reload and try again.".into(),
                    );
                }
                (Some(_), None) => {
                    return Err(format!("A template `{}` already exists.", template.id));
                }
                (None, Some(_)) => return Err("The template no longer exists.".into()),
                (None, None) if count >= MAX_TEMPLATES => {
                    return Err(format!("At most {MAX_TEMPLATES} templates."));
                }
                (None, None) => {
                    template.version = 1;
                    template.builtin = false;
                    templates.push(template);
                }
            }
            host::storage_set(
                TEMPLATES_KEY,
                &Templates {
                    templates: templates.clone(),
                },
                revision,
            )?;
        }
        "delete-template" => {
            let DeleteRequest { id } = decode(payload, "delete request")?;
            match templates.iter().position(|item| item.id == id) {
                Some(index) if templates[index].builtin => {
                    return Err("Built-in templates can be edited but not deleted.".into());
                }
                Some(index) => {
                    templates.remove(index);
                }
                None => return Err("The template no longer exists.".into()),
            }
            host::storage_set(
                TEMPLATES_KEY,
                &Templates {
                    templates: templates.clone(),
                },
                revision,
            )?;
        }
        _ => return Err("unknown command".into()),
    }
    encode(&json!({"templates": templates}))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    struct Sample {
        values: BTreeMap<&'static str, &'static str>,
        lines: Vec<String>,
    }

    impl Values for Sample {
        fn value(&self, code: &str) -> Option<&str> {
            self.values.get(code).copied()
        }
        fn record_id(&self) -> &str {
            "rec-1"
        }
        fn fingerprint(&self) -> &str {
            "0123456789abcdef0123"
        }
        fn all_lines(&self) -> &[String] {
            &self.lines
        }
    }

    fn sample() -> Sample {
        Sample {
            values: BTreeMap::from([("title", "Alpha"), ("price_gross", "122.99")]),
            lines: vec!["title: Alpha".into(), "price_gross: 122.99".into()],
        }
    }

    fn template(title: &str, body: &str) -> DocumentTemplate {
        DocumentTemplate {
            id: "sheet".into(),
            name: "Sheet".into(),
            title: title.into(),
            body: body.into(),
            version: 1,
            builtin: false,
        }
    }

    #[test]
    fn builtins_are_valid() {
        for template in builtins() {
            template.validate().unwrap();
        }
    }

    #[test]
    fn marks_are_replaced_and_missing_values_reported() {
        let (text, missing) = render(
            "Gross: {{price_gross}} EUR, net {{ price_net }} ({{ record.id }}, {{ record.fingerprint }})",
            &sample(),
            "—",
        );
        assert_eq!(text, "Gross: 122.99 EUR, net — (rec-1, 0123456789abcdef)");
        assert_eq!(missing, ["price_net"]);
        assert_eq!(
            render("{{ record.values }}", &sample(), "").0,
            "title: Alpha\nprice_gross: 122.99"
        );
    }

    #[test]
    fn validation_rejects_bad_marks_and_bounds() {
        assert!(
            template("{{ title }}", "Gross {{ price_gross }}")
                .validate()
                .is_ok()
        );
        assert!(
            template("{{ title }}", "Gross {{ price_gross")
                .validate()
                .is_err()
        );
        assert!(
            template("{{ title }}", "{{ Price Gross }}")
                .validate()
                .is_err()
        );
        assert!(template("{{ record.values }}", "body").validate().is_err());
        assert!(template("{{ title }}", "  ").validate().is_err());
        let (codes, all) = template(
            "{{ title }}",
            "{{ record.values }} {{ price_net }} {{ record.id }}",
        )
        .references();
        assert_eq!(
            codes.into_iter().collect::<Vec<_>>(),
            ["price_net", "title"]
        );
        assert!(all);
    }
}
