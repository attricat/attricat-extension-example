//! Document templates, managed from the Document templates route and kept in
//! extension storage under one key. Until the first save the built-in
//! `summary` and `label` templates apply. Every save bumps the template's
//! version; a run names the version it was started with and snapshots that
//! template, so later edits never change a started or retried run.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::host::{self, decode, encode};

pub const TEMPLATES_KEY: &str = "templates";
const MAX_TEMPLATES: usize = 20;
const MAX_ATTRIBUTES: usize = 40;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Layout {
    /// The selected saved values, one per line.
    Summary,
    /// The record's title, ID and content fingerprint.
    Label,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DocumentTemplate {
    pub id: String,
    pub name: String,
    pub layout: Layout,
    /// Printed above the record's content on every page.
    #[serde(default)]
    pub heading: String,
    /// Attribute codes a summary prints, in order; empty prints every saved value.
    #[serde(default)]
    pub attributes: Vec<String>,
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
            layout: Layout::Summary,
            heading: String::new(),
            attributes: Vec::new(),
            version: 1,
            builtin: true,
        },
        DocumentTemplate {
            id: "label".into(),
            name: "Product label".into(),
            layout: Layout::Label,
            heading: String::new(),
            attributes: Vec::new(),
            version: 1,
            builtin: true,
        },
    ]
}

/// The stored templates with their storage revision, or the built-ins.
pub fn load() -> Result<(Vec<DocumentTemplate>, Option<i64>), String> {
    Ok(match host::storage_get::<Templates>(TEMPLATES_KEY)? {
        Some((stored, revision)) => (stored.templates, Some(revision)),
        None => (builtins(), None),
    })
}

fn local_name(value: &str, max: usize) -> bool {
    (1..=max).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

impl DocumentTemplate {
    pub fn validate(&self) -> Result<(), String> {
        if !local_name(&self.id, 32) {
            return Err("Template IDs are 1-32 lowercase letters, digits, `-` or `_`.".into());
        }
        if self.name.trim().is_empty() || self.name.chars().count() > 60 {
            return Err("Template names are 1-60 characters.".into());
        }
        if self.heading.chars().count() > 120 {
            return Err("Headings are at most 120 characters.".into());
        }
        if self.attributes.len() > MAX_ATTRIBUTES {
            return Err(format!(
                "A template prints at most {MAX_ATTRIBUTES} attributes."
            ));
        }
        if self.layout == Layout::Label && !self.attributes.is_empty() {
            return Err("Label templates print no attributes.".into());
        }
        if let Some(code) = self.attributes.iter().find(|code| !local_name(code, 64)) {
            return Err(format!("`{code}` is not an attribute code."));
        }
        Ok(())
    }
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

fn listing(templates: &[DocumentTemplate]) -> Result<String, String> {
    encode(&json!({"templates": templates}))
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
    listing(&templates)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn template(id: &str, layout: Layout, attributes: &[&str]) -> DocumentTemplate {
        DocumentTemplate {
            id: id.into(),
            name: "Name".into(),
            layout,
            heading: String::new(),
            attributes: attributes.iter().map(|code| (*code).to_owned()).collect(),
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
    fn validation_bounds_ids_layouts_and_codes() {
        assert!(
            template("Price Sheet", Layout::Summary, &[])
                .validate()
                .is_err()
        );
        assert!(
            template("labels", Layout::Label, &["title"])
                .validate()
                .is_err()
        );
        assert!(
            template("sheet", Layout::Summary, &["not a code"])
                .validate()
                .is_err()
        );
        assert!(
            template("sheet", Layout::Summary, &["title", "price_net"])
                .validate()
                .is_ok()
        );
    }
}
