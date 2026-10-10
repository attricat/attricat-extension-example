//! Attricat example extension: context-aware computed numeric attributes.
//!
//! One component on the `catalog:host@1.0.0` ABI exports both
//! interfaces of the `catalog-extension` world:
//!
//! - `handler`: the `record.updated.v1` event handler and client commands
//!   ([`handler`]).
//! - `operations`: the interactive `recalculate-selection` operation
//!   ([`operation`]).
//!
//! Formula logic is host-independent ([`formulas`]); extension-owned state lives
//! in `storage.extension` ([`activity`]); host calls are wrapped in [`host`].

wit_bindgen::generate!({
    path: "wit",
    world: "catalog-extension",
});

mod activity;
mod formulas;
mod handler;
mod host;
mod operation;

use catalog::host::api::Event;
use exports::catalog::host::{
    handler::{CommandRequest, CommandResponse},
    operations::{BatchResult, OperationRequest},
};

struct Extension;

impl exports::catalog::host::handler::Guest for Extension {
    fn handle_event(event: Event) -> Result<(), String> {
        handler::handle_event(event)
    }

    fn handle_command(request: CommandRequest) -> Result<CommandResponse, String> {
        handler::handle_command(request)
    }
}

impl exports::catalog::host::operations::Guest for Extension {
    fn prepare(request: OperationRequest) -> Result<String, String> {
        operation::prepare(request).map_err(operation::diagnostic)
    }

    fn start(_request: OperationRequest) -> Result<String, String> {
        Ok("started".into())
    }

    fn process_batch(request: OperationRequest) -> Result<BatchResult, String> {
        operation::process_batch(request).map_err(operation::diagnostic)
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
