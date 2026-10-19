//! Print one JSON array for cross-runtime comparison, with no network or host setup.

use std::error::Error;
use std::fs;

use hyperion_wire_protocol::{protocol_profile, run_operation};
use serde_json::{Value, json};

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: run-vectors <fixtures/protocol-vectors.json>")?;
    let fixtures: Value = serde_json::from_str(&fs::read_to_string(path)?)?;
    if fixtures["schemaVersion"] != 1 || &fixtures["profile"] != protocol_profile() {
        return Err("fixture schema/profile does not match the bundled engineering profile".into());
    }
    let vectors = fixtures["vectors"]
        .as_array()
        .ok_or("missing vectors array")?;
    let mut results = Vec::with_capacity(vectors.len());
    for vector in vectors {
        let id = vector["id"].as_str().ok_or("missing vector id")?;
        let operation = vector["operation"].as_str().ok_or("missing operation")?;
        results.push(match run_operation(operation, &vector["input"]) {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(error) => json!({ "id": id, "error": error.code() }),
        });
    }
    println!("{}", serde_json::to_string(&results)?);
    Ok(())
}
