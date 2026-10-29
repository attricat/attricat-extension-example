//! Attricat example extension: context-aware computed numeric attributes.
//!
//! One component on the `attricat:host@1.1.0` ABI exports both
//! interfaces of the `attricat-extension` world:
//!
//! - `handler`: the `record.updated.v1` event handler and client commands
//!   ([`handler`]).
//! - `operations`: the interactive `recalculate-selection` ([`operation`]) and
//!   `generate-documents` ([`documents`]) operations.
//!
//! Formula logic is host-independent ([`formulas`]); extension-owned state lives
//! in `storage.extension` ([`activity`]); host calls are wrapped in [`host`].

wit_bindgen::generate!({
    path: "wit",
    world: "attricat-extension",
});

mod activity;
mod documents;
mod formulas;
mod handler;
mod host;
mod operation;

use attricat::host::api::Event;
use exports::attricat::host::{
    handler::{CommandRequest, CommandResponse},
    operations::{BatchResult, OperationRequest},
};

struct Extension;

impl exports::attricat::host::handler::Guest for Extension {
    fn handle_event(event: Event) -> Result<(), String> {
        handler::handle_event(event)
    }

    fn handle_command(request: CommandRequest) -> Result<CommandResponse, String> {
        handler::handle_command(request)
    }
}

impl exports::attricat::host::operations::Guest for Extension {
    fn prepare(request: OperationRequest) -> Result<String, String> {
        match request.operation_id.as_str() {
            documents::OPERATION => documents::prepare(&request),
            _ => operation::prepare(request).map_err(operation::diagnostic),
        }
    }

    fn start(_request: OperationRequest) -> Result<String, String> {
        Ok("started".into())
    }

    fn process_batch(request: OperationRequest) -> Result<BatchResult, String> {
        match request.operation_id.as_str() {
            documents::OPERATION => documents::process_batch(&request),
            _ => operation::process_batch(request).map_err(operation::diagnostic),
        }
    }

    fn checkpoint(_request: OperationRequest) -> Result<(), String> {
        Ok(())
    }

    fn finish(_request: OperationRequest) -> Result<(), String> {
        Ok(())
    }

    fn cancel(_request: OperationRequest) -> Result<(), String> {
        Ok(())
    }
}

export!(Extension);
