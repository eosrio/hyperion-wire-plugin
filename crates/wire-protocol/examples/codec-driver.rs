//! Executable, JSON-only conformance boundary shared with the Node component.
use hyperion_wire_protocol::codec::{
    CodecProfile, decode_abi, decode_value, encode_abi, encode_value,
};
use serde_json::{Value, json};
use std::io::Read;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(value: &Value) -> Option<Vec<u8>> {
    let text = value.as_str()?;
    if text.len() % 2 != 0
        || text.len() > 32 * 1024 * 1024
        || !text
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}
fn run(op: &Value) -> Value {
    let profile = match op.get("profileId").and_then(Value::as_str) {
        Some(id) => match CodecProfile::for_id(id) {
            Ok(p) => p,
            Err(e) => return json!({"error": e.code()}),
        },
        None => CodecProfile::default(),
    };
    let name = op["typeName"].as_str().unwrap_or("");
    let result = match op["operation"].as_str() {
        Some("decodeAbi") | Some("decodeValue") | Some("decodeDeltas") => {
            let Some(bytes) = unhex(&op["hex"]) else {
                return json!({"error": "invalid_value"});
            };
            if op["operation"] == "decodeAbi" {
                decode_abi(&bytes, &profile)
            } else if op["operation"] == "decodeDeltas" {
                hyperion_wire_protocol::codec::ship::decode_deltas(&op["abi"], &bytes, &profile)
            } else {
                decode_value(&op["abi"], name, &bytes, &profile)
            }
        }
        Some("encodeAbi") => encode_abi(&op["abi"], &profile).map(|bytes| json!(hex(&bytes))),
        Some("encodeValue") => {
            encode_value(&op["abi"], name, &op["value"], &profile).map(|bytes| json!(hex(&bytes)))
        }
        _ => panic!("unsupported codec operation"),
    };
    match result {
        Ok(value) => json!({"result": value}),
        Err(error) => json!({"error": error.code()}),
    }
}
fn main() {
    let mut source = String::new();
    if let Some(path) = std::env::args().nth(1) {
        source = std::fs::read_to_string(path).expect("fixture file");
    } else {
        std::io::stdin()
            .read_to_string(&mut source)
            .expect("fixture stdin");
    }
    let ops: Vec<Value> = serde_json::from_str(&source).expect("JSON array of codec operations");
    println!("{}", Value::Array(ops.iter().map(run).collect()));
}
