//! The `webhook-receiver` export (attricat:host 1.2) and the handler of the
//! payloads it keeps: an external system pushes values into the catalog.
//!
//! `receive` runs while the sender waits and may only read configuration,
//! secrets and storage, so it does no more than authenticate the request and
//! keep its body. The `webhook.received.v1` handler writes the value later,
//! with retries, through the ordinary event delivery.
//!
//! Requests are signed like Stripe's: `x-example-signature: t=<unix
//! seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, keyed with the extension
//! secret named by the `webhook_secret` configuration field. A signature
//! older than [`MAX_SIGNATURE_AGE_SECONDS`] is refused, so a captured request
//! cannot be replayed later, and `x-example-delivery` deduplicates a sender's
//! retries. A `GET` with `challenge=<value>` is answered with the value, the
//! verification handshake some senders make before they deliver.

use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Sha256;

use crate::activity::{self, Entry};
use crate::attricat::host::api::{self, Event, ScalarWrite, WriteRequest};
use crate::attricat::host::clock;
use crate::attricat::host::outcomes::{Failure, Rejection};
use crate::exports::attricat::host::webhook_receiver::{
    KeptPayload, WebhookHeader, WebhookOutcome, WebhookReply, WebhookRequest,
};
use crate::host::{decode, encode};

/// The manifest webhook this module answers.
pub const WEBHOOK: &str = "external-values";
pub const RECEIVED_EVENT: &str = "webhook.received.v1";
const SIGNATURE_HEADER: &str = "x-example-signature";
const DELIVERY_HEADER: &str = "x-example-delivery";
/// The extension secret used when configuration names none.
const DEFAULT_SECRET: &str = "example-webhook-secret";
pub const MAX_SIGNATURE_AGE_SECONDS: u64 = 300;

const STATUS_OK: u16 = 200;
const STATUS_ACCEPTED: u16 = 202;
const STATUS_BAD_REQUEST: u16 = 400;
const STATUS_UNAUTHORIZED: u16 = 401;
const STATUS_NOT_FOUND: u16 = 404;

/// One value an external system sets.
#[derive(Deserialize)]
struct ExternalValue {
    record_id: String,
    context_id: String,
    attribute_code: String,
    value: f64,
}

fn reply(status: u16, body: &str) -> WebhookOutcome {
    WebhookOutcome {
        reply: WebhookReply {
            status,
            headers: vec![WebhookHeader {
                name: "content-type".into(),
                value: "application/json".into(),
            }],
            body: json!({"status": body}).to_string(),
        },
        keep: None,
    }
}

fn header<'a>(request: &'a WebhookRequest, name: &str) -> Option<&'a str> {
    request
        .headers
        .iter()
        .find(|header| header.name == name)
        .map(|header| header.value.as_str())
}

fn secret_name() -> Result<String, String> {
    let configuration: Value = decode(&api::call("configuration.get.v1", "{}")?, "configuration")?;
    Ok(configuration
        .get("webhook_secret")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_SECRET)
        .to_owned())
}

/// Checks `t=<seconds>,v1=<hex>` against `secret` at `now`.
pub fn verify(secret: &[u8], signature: &str, body: &[u8], now: u64) -> bool {
    let mut timestamp = None;
    let mut expected = None;
    for part in signature.split(',') {
        match part.trim().split_once('=') {
            Some(("t", value)) => timestamp = value.parse::<u64>().ok(),
            Some(("v1", value)) => expected = hex_decode(value),
            _ => {}
        }
    }
    let (Some(timestamp), Some(expected)) = (timestamp, expected) else {
        return false;
    };
    if now.abs_diff(timestamp) > MAX_SIGNATURE_AGE_SECONDS {
        return false;
    }
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret) else {
        return false;
    };
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    // `verify_slice` compares in constant time.
    mac.verify_slice(&expected).is_ok()
}

fn hex_decode(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 {
        return None;
    }
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(value.get(index..index + 2)?, 16).ok())
        .collect()
}

pub fn receive(request: WebhookRequest) -> Result<WebhookOutcome, String> {
    if request.webhook != WEBHOOK {
        return Ok(reply(STATUS_NOT_FOUND, "unknown webhook"));
    }
    if request.method == "GET" {
        return Ok(
            match request
                .query
                .split('&')
                .find_map(|pair| pair.strip_prefix("challenge="))
            {
                Some(challenge) => WebhookOutcome {
                    reply: WebhookReply {
                        status: STATUS_OK,
                        headers: vec![WebhookHeader {
                            name: "content-type".into(),
                            value: "text/plain".into(),
                        }],
                        body: challenge.into(),
                    },
                    keep: None,
                },
                None => reply(STATUS_BAD_REQUEST, "missing challenge"),
            },
        );
    }
    let secret = api::call(
        "secrets.get.v1",
        &json!({"name": secret_name()?}).to_string(),
    )?;
    let secret: Value = decode(&secret, "secret")?;
    let secret = secret["value"].as_str().unwrap_or_default();
    let signed = header(&request, SIGNATURE_HEADER).is_some_and(|signature| {
        verify(
            secret.as_bytes(),
            signature,
            &request.body,
            clock::now().seconds,
        )
    });
    if !signed {
        return Ok(reply(STATUS_UNAUTHORIZED, "invalid signature"));
    }
    let Ok(body) = String::from_utf8(request.body.clone()) else {
        return Ok(reply(STATUS_BAD_REQUEST, "body is not UTF-8"));
    };
    if serde_json::from_str::<ExternalValue>(&body).is_err() {
        return Ok(reply(
            STATUS_BAD_REQUEST,
            "expected record_id, context_id, attribute_code and value",
        ));
    }
    let mut outcome = reply(STATUS_ACCEPTED, "accepted");
    outcome.keep = Some(KeptPayload {
        payload: body,
        dedupe_key: header(&request, DELIVERY_HEADER).map(str::to_owned),
    });
    Ok(outcome)
}

/// Writes a kept value. A receipt the retention sweep already removed, or a
/// payload the catalog refuses, is rejected rather than retried.
pub fn handle_received(event: &Event) -> Result<(), Failure> {
    let rejected = |code: &str, message: String, record_id: Option<String>| {
        Failure::Rejected(Rejection {
            code: code.into(),
            message,
            record_id,
            connection: None,
        })
    };
    let announced: Value = decode(&event.payload, "webhook event")
        .map_err(|error| rejected("invalid_payload", error, None))?;
    if announced["webhook"] != WEBHOOK {
        return Ok(());
    }
    let receipt = api::call(
        "webhooks.receipt.get.v1",
        &json!({"receipt_id": announced["receipt_id"]}).to_string(),
    )?;
    let receipt: Value = decode(&receipt, "webhook receipt")?;
    let Some(payload) = receipt["payload"].as_str() else {
        return Err(rejected(
            "receipt_expired",
            "the webhook payload is no longer kept".into(),
            None,
        ));
    };
    let value: ExternalValue = decode(payload, "external value")
        .map_err(|error| rejected("invalid_payload", error, None))?;
    let written = api::write(&WriteRequest {
        record_id: value.record_id.clone(),
        values: vec![ScalarWrite {
            attribute_id: None,
            attribute_code: Some(value.attribute_code.clone()),
            context_id: value.context_id.clone(),
            value: encode(&value.value)?,
        }],
    });
    let error = written.as_ref().err().cloned();
    activity::record(
        &[Entry {
            source: "webhook".into(),
            reference: receipt["id"].as_str().map(str::to_owned),
            record_id: Some(value.record_id.clone()),
            context_id: Some(value.context_id.clone()),
            target_code: Some(value.attribute_code.clone()),
            result: Some(value.value),
            written: error.is_none(),
            error: error.clone(),
            at: None,
        }],
        0,
    );
    match error {
        Some(error) => Err(rejected("write_refused", error, Some(value.record_id))),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign(secret: &str, timestamp: u64, body: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(format!("{timestamp}.{body}").as_bytes());
        let digest = mac.finalize().into_bytes();
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        format!("t={timestamp},v1={hex}")
    }

    #[test]
    fn signatures_are_keyed_bound_to_the_body_and_fresh() {
        let now = 1_800_000_000;
        let body = br#"{"value":1}"#;
        let signature = sign("s3cret", now, r#"{"value":1}"#);
        assert!(verify(b"s3cret", &signature, body, now));
        assert!(verify(
            b"s3cret",
            &signature,
            body,
            now + MAX_SIGNATURE_AGE_SECONDS
        ));
        assert!(!verify(
            b"s3cret",
            &signature,
            body,
            now + MAX_SIGNATURE_AGE_SECONDS + 1
        ));
        assert!(!verify(b"other", &signature, body, now));
        assert!(!verify(b"s3cret", &signature, br#"{"value":2}"#, now));
        assert!(!verify(b"s3cret", "v1=00", body, now));
        assert!(!verify(b"s3cret", "t=1,v1=zz", body, now));
    }
}
