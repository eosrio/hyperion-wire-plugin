//! Source-pinned ABI occurrence observations, not canonical ABI selection.
//!
//! These facts come from complete accepted-block SHiP inputs. The host retains
//! source identity, journals them durably, and separately proves coverage/forks.

use super::binary::{Reader, hex, unhex};
use super::scalar::{name_from_u64, name_to_u64, parse_unsigned};
use super::{
    CodecError, CodecProfile, MAX_DEPTH, MAX_ELEMENTS, array, check_json, decode_value,
    encode_value, object, string,
};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

fn account_abi() -> Value {
    json!({"version":"sysio::abi/1.3", "structs":[
        {"name":"account_v0","base":"","fields":[
            {"name":"name","type":"name"},
            {"name":"creation_date","type":"block_timestamp_type"},
            {"name":"abi","type":"bytes"}
        ]}
    ], "variants":[{"name":"account","types":["account_v0"]}]})
}

fn field<'a>(value: &'a Map<String, Value>, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn variant<'a>(value: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>, CodecError> {
    let parts = value
        .as_array()
        .filter(|parts| parts.len() == 2 && parts[0].is_string())
        .ok_or_else(|| CodecError::value("malformed ABI observation variant"))?;
    if !allowed.contains(&parts[0].as_str().unwrap()) {
        return Err(CodecError::unsupported(
            "unsupported ABI observation variant",
        ));
    }
    object(&parts[1])
}

fn ordinal(value: &Value, positive: bool) -> Result<u32, CodecError> {
    let number = value
        .as_f64()
        .filter(|value| {
            value.is_finite()
                && value.fract() == 0.0
                && *value >= if positive { 1.0 } else { 0.0 }
                && *value <= f64::from(u32::MAX)
        })
        .ok_or_else(|| CodecError::value("invalid source ordinal"))?;
    Ok(number as u32)
}

fn digest(value: &Value) -> Result<(), CodecError> {
    let value = string(value)?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(CodecError::value("invalid source digest"));
    }
    Ok(())
}

fn name(value: &Value) -> Result<String, CodecError> {
    let value = string(value)?;
    let decoded = name_from_u64(name_to_u64(value)?);
    if decoded != value {
        return Err(CodecError::value("invalid source account name"));
    }
    Ok(decoded)
}

fn sequence(value: &Value, bits: u32, positive: bool) -> Result<u64, CodecError> {
    if bits == 64 && !value.is_string() {
        return Err(CodecError::value("expected lossless decimal uint64"));
    }
    let number = parse_unsigned(value, bits)? as u64;
    if positive && number == 0 {
        return Err(CodecError::value(
            "a committed receipt requires a positive global sequence",
        ));
    }
    Ok(number)
}

fn context_free_flag(value: &Value) -> Result<bool, CodecError> {
    match value {
        Value::Bool(value) => Ok(*value),
        Value::Number(value) if value.as_f64() == Some(0.0) => Ok(false),
        Value::Number(value) if value.as_f64() == Some(1.0) => Ok(true),
        _ => Err(CodecError::value("invalid source context-free flag")),
    }
}

/// Native fc::raw::unpack reads a prefix and accepts noncanonical lengths.
/// Mirror raw.hpp's low-32-bit, at-most-five-byte unsigned_int semantics only
/// here; the generic ABI/value codec deliberately retains strict framing.
fn native_abi(bytes: &[u8]) -> Result<(String, String), CodecError> {
    let mut reader = Reader::new(bytes)?;
    let account = name_from_u64(u64::from_le_bytes(reader.fixed()?));
    let mut size = 0u32;
    for index in 0..5 {
        let byte = reader.byte()?;
        size |= u32::from(byte & 127).wrapping_shl(7 * index);
        if byte & 128 == 0 {
            break;
        }
    }
    Ok((account, hex(reader.read(size as usize)?)))
}

struct Occurrence {
    fact: Value,
    ordinal: u32,
    creator: u32,
    sequence: u64,
    context_free: bool,
    action_identity: Value,
}

/// Extract detached source facts for the selected engineering profile.
///
/// `input` uses JSON account rows `{ordinal,present,rawHex,value}`. The typed
/// Node SDK carries the same raw bytes as Uint8Array. Missing required inputs
/// fail instead of being converted into successful empty observations.
pub fn observe_block_abi(
    input: &Value,
    source: &Value,
    profile: &CodecProfile,
) -> Result<Value, CodecError> {
    profile.validate()?;
    check_json(input)?;
    check_json(source)?;
    object(source)?;
    digest(&source["chainId"])?;
    digest(&source["blockId"])?;
    if source.get("previousBlockId") != Some(&Value::Null) {
        digest(&source["previousBlockId"])?;
    }
    ordinal(&source["blockNum"], true)?;
    object(input)?;
    let transactions = array(&input["traces"])?;
    let rows = array(&input["accountRows"])?;
    let physical = account_abi();
    let mut action_inputs = Vec::new();
    let mut deployments = Vec::new();
    let mut seen_transactions = HashSet::new();
    let mut seen_sequences = HashSet::new();
    for raw_transaction in transactions {
        let transaction = variant(raw_transaction, &["transaction_trace_v0"])?;
        digest(field(transaction, "id"))?;
        let transaction_id = string(field(transaction, "id"))?;
        if !seen_transactions.insert(transaction_id) {
            return Err(CodecError::value("duplicate source transaction"));
        }
        if transaction.get("status").and_then(Value::as_f64) != Some(0.0)
            || !(transaction.get("scheduled") == Some(&Value::Bool(false))
                || transaction.get("scheduled").and_then(Value::as_f64) == Some(0.0))
            || transaction.get("failed_dtrx_trace") != Some(&Value::Null)
        {
            return Err(CodecError::unsupported(
                "unsupported committed Wire transaction semantics",
            ));
        }
        if transaction.get("except") != Some(&Value::Null)
            || transaction.get("error_code") != Some(&Value::Null)
        {
            return Err(CodecError::value(
                "failed transaction is not a committed ABI source",
            ));
        }
        let actions = array(field(transaction, "action_traces"))?;
        if actions.len() > MAX_ELEMENTS.saturating_sub(action_inputs.len()) {
            return Err(CodecError::limits("ABI observation actions exceed limit"));
        }
        let mut occurrences = Vec::new();
        let mut indices = HashMap::new();
        for raw in actions {
            let trace = variant(raw, &["action_trace_v0", "action_trace_v1"])?;
            let action_ordinal = ordinal(field(trace, "action_ordinal"), true)?;
            if indices.insert(action_ordinal, occurrences.len()).is_some() {
                return Err(CodecError::value("duplicate source action ordinal"));
            }
            let creator = ordinal(field(trace, "creator_action_ordinal"), false)?;
            if trace.get("except") != Some(&Value::Null)
                || trace.get("error_code") != Some(&Value::Null)
            {
                return Err(CodecError::value(
                    "failed action is not a committed ABI source",
                ));
            }
            let context_free = context_free_flag(field(trace, "context_free"))?;
            let receipt = variant(field(trace, "receipt"), &["action_receipt_v0"])?;
            let receiver = name(field(trace, "receiver"))?;
            if name(field(receipt, "receiver"))? != receiver {
                return Err(CodecError::value(
                    "receipt receiver does not match source action",
                ));
            }
            let global_sequence = sequence(field(receipt, "global_sequence"), 64, true)?;
            if !seen_sequences.insert(global_sequence) {
                return Err(CodecError::value("duplicate committed global sequence"));
            }
            let action = object(field(trace, "act"))?;
            let account = name(field(action, "account"))?;
            let action_name = name(field(action, "name"))?;
            let raw_hex = hex(&unhex(string(field(action, "data"))?)?);
            let authorization = array(field(action, "authorization"))?
                .iter()
                .map(|permission| {
                    let permission = object(permission)?;
                    Ok(json!([
                        name(field(permission, "actor"))?,
                        name(field(permission, "permission"))?
                    ]))
                })
                .collect::<Result<Vec<_>, CodecError>>()?;
            let receipt_abi_sequence = sequence(field(receipt, "abi_sequence"), 32, false)?;
            occurrences.push(Occurrence {
                fact: json!({
                    "transactionId":transaction_id,"actionOrdinal":action_ordinal,
                    "receiver":receiver,"account":account,"name":action_name,
                    "rawHex":raw_hex,"globalSequence":global_sequence.to_string(),
                    "receiptAbiSequence":receipt_abi_sequence.to_string()
                }),
                ordinal: action_ordinal,
                creator,
                sequence: global_sequence,
                context_free,
                action_identity: json!([
                    account,
                    action_name,
                    authorization,
                    raw_hex,
                    context_free
                ]),
            });
        }
        for entry in &occurrences {
            if entry.creator != 0
                && indices
                    .get(&entry.creator)
                    .is_none_or(|index| occurrences[*index].sequence >= entry.sequence)
            {
                return Err(CodecError::value(
                    "missing, cyclic or unordered creator ancestry",
                ));
            }
        }
        let mut origins = HashMap::new();
        for entry in &occurrences {
            let mut current = entry;
            let mut path = Vec::new();
            while !origins.contains_key(&current.ordinal)
                && current.fact["receiver"] != current.fact["account"]
            {
                if path.len() >= MAX_DEPTH {
                    return Err(CodecError::limits("notification ancestry exceeds limit"));
                }
                path.push(current.ordinal);
                let parent = indices
                    .get(&current.creator)
                    .map(|index| &occurrences[*index])
                    .ok_or_else(|| CodecError::value("notification origin is missing"))?;
                if parent.action_identity != current.action_identity {
                    return Err(CodecError::value(
                        "notification does not match its originating action input",
                    ));
                }
                current = parent;
            }
            let origin = origins
                .get(&current.ordinal)
                .copied()
                .unwrap_or(current.ordinal);
            origins.insert(current.ordinal, origin);
            for ordinal in path {
                origins.insert(ordinal, origin);
            }
            let mut fact = entry.fact.clone();
            fact["inputActionOrdinal"] = json!(origin);
            if fact["receiver"] == "sysio" && fact["account"] == "sysio" && fact["name"] == "setabi"
            {
                if entry.context_free {
                    return Err(CodecError::unsupported(
                        "context-free native ABI mutation is unsupported",
                    ));
                }
                let (account, abi_hex) = native_abi(&unhex(string(&fact["rawHex"])?)?)?;
                deployments.push(json!({
                    "account":account,"abiHex":abi_hex,
                    "action":{"transactionId":transaction_id,"actionOrdinal":entry.ordinal},
                    "globalSequence":entry.sequence.to_string(),"effect":"native-before-receipt"
                }));
            }
            action_inputs.push(fact);
        }
    }
    let mut seen_rows = HashSet::new();
    let mut seen_accounts = HashSet::new();
    let mut final_states = Vec::new();
    for row in rows {
        object(row)?;
        let delta_ordinal = ordinal(&row["ordinal"], false)?;
        if !seen_rows.insert(delta_ordinal) {
            return Err(CodecError::value("duplicate source account row ordinal"));
        }
        let present = row["present"]
            .as_bool()
            .ok_or_else(|| CodecError::value("invalid source account row"))?;
        let raw = unhex(string(&row["rawHex"])?)?;
        let decoded_value = decode_value(&physical, "account", &raw, profile)?;
        let decoded = variant(&decoded_value, &["account_v0"])?;
        if encode_value(&physical, "account", &row["value"], profile)? != raw {
            return Err(CodecError::value(
                "account row does not match its raw bytes",
            ));
        }
        let account = name(field(decoded, "name"))?;
        if !seen_accounts.insert(account.clone()) {
            return Err(CodecError::value("duplicate final account state"));
        }
        final_states.push(json!({
            "account":account,"present":present,
            "abiHex":hex(&unhex(string(field(decoded, "abi"))?)?),"deltaOrdinal":delta_ordinal
        }));
    }
    let sequence_order = |left: &Value, right: &Value| {
        // The values were validated and emitted from u64 above.
        left["globalSequence"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            .cmp(&right["globalSequence"].as_str().unwrap().parse().unwrap())
    };
    action_inputs.sort_by(sequence_order);
    deployments.sort_by(sequence_order);
    final_states.sort_by_key(|state| state["deltaOrdinal"].as_u64().unwrap());
    Ok(json!({"schemaVersion":1,"actionInputs":action_inputs,
        "deployments":deployments,"finalStates":final_states}))
}
