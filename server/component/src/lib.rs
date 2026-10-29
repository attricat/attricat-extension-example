//! Attricat example extension: context-aware computed numeric attributes and
//! PDF documents.
//!
//! One component on the `attricat:host@1.1.0` ABI exports the three
//! interfaces of the `outcome-extension` world:
//!
//! - `event-handler`: the `record.updated.v1` handler, with the delivery's
//!   source and typed outcomes ([`handler`]).
//! - `command-handler`: the client commands ([`handler`]).
//! - `deferrable-operations`: the interactive `recalculate-selection`
//!   ([`operation`]) and `generate-documents` ([`documents`]) operations.
//!
//! Formula logic is host-independent ([`formulas`]); extension-owned state lives
//! in `storage.extension` ([`activity`]); host calls are wrapped in [`host`].

wit_bindgen::generate!({
    path: "wit",
    world: "outcome-extension",
});

mod activity;
mod documents;
mod formulas;
mod handler;
mod host;
mod operation;

use attricat::host::api::Event;
use attricat::host::outcomes::{Failure, Retry};
use exports::attricat::host::{
    command_handler::{CommandRequest, CommandResponse},
    deferrable_operations::{BatchOutcome, OperationRequest},
    event_handler::Delivery,
};

/// Host call failures are temporary: the host retries the delivery or batch
/// with backoff instead of quarantining the installation.
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Failure::Retry(Retry {
            message,
            after_ms: None,
        })
    }
}

struct Extension;

impl exports::attricat::host::event_handler::Guest for Extension {
    fn handle_event(event: Event, delivery: Delivery) -> Result<(), Failure> {
        handler::handle_event(event, delivery)
    }
}

impl exports::attricat::host::command_handler::Guest for Extension {
    fn handle_command(request: CommandRequest) -> Result<CommandResponse, String> {
        handler::handle_command(request)
    }
}

impl exports::attricat::host::deferrable_operations::Guest for Extension {
    fn prepare(request: OperationRequest) -> Result<String, String> {
        match request.operation_id.as_str() {
            documents::OPERATION => documents::prepare(&request),
            _ => operation::prepare(request).map_err(operation::diagnostic),
        }
    }

    fn start(_request: OperationRequest) -> Result<String, String> {
        Ok("started".into())
    }

    fn process_batch(request: OperationRequest) -> Result<BatchOutcome, Failure> {
        match request.operation_id.as_str() {
            documents::OPERATION => documents::process_batch(&request),
            _ => operation::process_batch(request),
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
