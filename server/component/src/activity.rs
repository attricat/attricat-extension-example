//! Extension-owned state in `storage.extension`: a bounded activity log with
//! counters, and the per-revision formula index. Server code writes both;
//! client contributions (including read-only panels) read them through
//! `catalog.storage`.

use serde::{Deserialize, Serialize};

use crate::formulas::{BlueprintWithAttributes, FormulaIndex};
use crate::host;

pub const ACTIVITY_KEY: &str = "activity";
const MAX_ENTRIES: usize = 25;
const MAX_MESSAGE_CHARS: usize = 240;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Stats {
    pub evaluations: u64,
    pub writes: u64,
    pub errors: u64,
    pub runs: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Entry {
    /// `event`, `command` or `run`.
    pub source: String,
    /// The triggering event ID, or the run ID.
    pub reference: Option<String>,
    pub entity_id: Option<String>,
    pub context_id: Option<String>,
    pub target_code: Option<String>,
    pub result: Option<f64>,
    pub written: bool,
    pub error: Option<String>,
}

impl Entry {
    pub fn error(
        source: &str,
        reference: Option<String>,
        entity_id: Option<String>,
        error: &str,
    ) -> Self {
        Self {
            source: source.into(),
            reference,
            entity_id,
            context_id: None,
            target_code: None,
            result: None,
            written: false,
            error: Some(error.chars().take(MAX_MESSAGE_CHARS).collect()),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Activity {
    pub stats: Stats,
    /// Newest first.
    pub entries: Vec<Entry>,
}

impl Activity {
    pub fn record(&mut self, entries: &[Entry], evaluations: u64) {
        self.stats.evaluations += evaluations;
        for entry in entries {
            self.stats.writes += u64::from(entry.written);
            self.stats.errors += u64::from(entry.error.is_some());
            self.stats.runs += u64::from(entry.source == "run");
        }
        let mut next: Vec<_> = entries.iter().rev().cloned().collect();
        next.append(&mut self.entries);
        next.truncate(MAX_ENTRIES);
        self.entries = next;
    }
}

/// Records activity without failing the caller: losing a log line must never
/// fail (and so quarantine) a formula write that already happened.
pub fn record(entries: &[Entry], evaluations: u64) {
    if entries.is_empty() && evaluations == 0 {
        return;
    }
    if let Err(error) = host::storage_update::<Activity, _>(ACTIVITY_KEY, |activity| {
        activity.record(entries, evaluations)
    }) {
        host::log("warn", &format!("activity log not updated: {error}"));
    }
}

/// Keeps the stored formula index for this revision current and returns it.
/// Writes only when the derived index changed.
pub fn refresh_index(blueprint: &BlueprintWithAttributes) -> FormulaIndex {
    let index = FormulaIndex::from_blueprint(blueprint);
    let key = FormulaIndex::key(&index.blueprint_id, index.blueprint_version);
    let stored = host::storage_get::<FormulaIndex>(&key);
    let unchanged = matches!(&stored, Ok(Some((existing, _))) if *existing == index);
    if !unchanged {
        let revision = stored.ok().flatten().map(|(_, revision)| revision);
        if let Err(error) = host::storage_set(&key, &index, revision) {
            host::log("warn", &format!("formula index not stored: {error}"));
        }
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(written: bool, error: Option<&str>) -> Entry {
        Entry {
            source: "event".into(),
            reference: None,
            entity_id: None,
            context_id: None,
            target_code: Some("gross".into()),
            result: Some(1.0),
            written,
            error: error.map(str::to_owned),
        }
    }

    #[test]
    fn record_counts_and_keeps_newest_first_bounded() {
        let mut activity = Activity::default();
        activity.record(&[entry(true, None), entry(false, Some("x"))], 2);
        assert_eq!(activity.stats.evaluations, 2);
        assert_eq!(activity.stats.writes, 1);
        assert_eq!(activity.stats.errors, 1);
        assert_eq!(activity.entries[0].error.as_deref(), Some("x"));
        for _ in 0..30 {
            activity.record(&[entry(true, None)], 1);
        }
        assert_eq!(activity.entries.len(), MAX_ENTRIES);
        assert_eq!(activity.stats.writes, 31);
    }

    #[test]
    fn error_messages_are_truncated() {
        let long = "e".repeat(1000);
        assert_eq!(
            Entry::error("event", None, None, &long)
                .error
                .unwrap()
                .len(),
            MAX_MESSAGE_CHARS
        );
    }
}
