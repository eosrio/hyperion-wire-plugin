//! Source-pinned native-action observations, never canonical decoding authority.
//!
//! The host must bind these detached decisions to its retained source, original
//! occurrence inventory, component pins and current canonical/fork authority.

use super::binary::{hex, unhex};
use super::observations::observe_block_abi;
use super::{
    CodecError, CodecProfile, MAX_BYTES, array, check_json, decode_value, encode_value, object,
    string,
};
use flate2::{Decompress, FlushDecompress, Status};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::OnceLock;

pub const ONBLOCK_KIND: &str = "wire.sysio.onblock.v1";
const SCHEMA_SHA256: &str = "94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9";
const MAX_SCHEMA_BYTES: usize = 65_536;
const MAX_PACKED_BYTES: usize = 10 * 1024 * 1024;
const HEADER_FIELDS: &[&str] = &[
    "timestamp",
    "producer",
    "previous",
    "transaction_mroot",
    "finality_mroot",
    "qc_claim",
    "new_finalizer_policy_diff",
    "new_proposer_policy_diff",
    "header_extensions",
];

fn native_abi() -> &'static Value {
    static ABI: OnceLock<Value> = OnceLock::new();
    ABI.get_or_init(|| {
        serde_json::from_str(include_str!("native_action_abi.json"))
            .expect("bundled native header ABI")
    })
}

fn profile_supported(profile: &CodecProfile) -> Result<(), CodecError> {
    profile.validate()?;
    if !matches!(
        profile.id.as_str(),
        "wire-sysio-6508c9e8-engineering-v1" | "wire-sysio-6508c9e8-native-engineering-v1"
    ) {
        return Err(CodecError::unsupported(
            "native actions require the selected 6508 profile",
        ));
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn exact_fields(value: &Map<String, Value>, expected: &[&str]) -> Result<(), CodecError> {
    if value.len() != expected.len() || expected.iter().any(|field| !value.contains_key(*field)) {
        return Err(CodecError::value("unexpected native source fields"));
    }
    Ok(())
}

fn digest(value: &Value) -> Result<&str, CodecError> {
    let text = string(value)?;
    if text.len() != 64
        || !text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(CodecError::value("invalid native source digest"));
    }
    Ok(text)
}

fn variant<'a>(value: &'a Value, tag: &str) -> Result<&'a Value, CodecError> {
    let values = array(value)?;
    if values.len() != 2 || values[0].as_str() != Some(tag) {
        return Err(CodecError::unsupported("unsupported native source variant"));
    }
    object(&values[1])?;
    Ok(&values[1])
}

fn header(block: &Value) -> Result<Value, CodecError> {
    object(block)?;
    HEADER_FIELDS
        .iter()
        .map(|name| {
            block
                .get(*name)
                .cloned()
                .map(|value| ((*name).into(), value))
                .ok_or_else(|| CodecError::value("missing native header field"))
        })
        .collect::<Result<Map<_, _>, _>>()
        .map(Value::Object)
}

fn header_id(
    schema: &Value,
    value: &Value,
    profile: &CodecProfile,
) -> Result<(String, u32), CodecError> {
    let previous = unhex(digest(&value["previous"])?)?;
    let number = u32::from_be_bytes(previous[..4].try_into().unwrap())
        .checked_add(1)
        .ok_or_else(|| CodecError::value("native block number overflows"))?;
    let mut bytes = Sha256::digest(encode_value(schema, "block_header", value, profile)?);
    bytes[..4].copy_from_slice(&number.to_be_bytes());
    Ok((hex(&bytes), number))
}

fn inflate(bytes: &[u8], limit: usize) -> Result<Vec<u8>, CodecError> {
    let mut decoder = Decompress::new(true);
    let mut output = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let before_in = decoder.total_in();
        let before_out = decoder.total_out();
        let offset =
            usize::try_from(before_in).map_err(|_| CodecError::limits("compressed input count"))?;
        let status = decoder
            .decompress(&bytes[offset..], &mut chunk, FlushDecompress::None)
            .map_err(|_| CodecError::value("invalid compressed packed transaction"))?;
        let written = usize::try_from(decoder.total_out() - before_out)
            .map_err(|_| CodecError::limits("inflated output count"))?;
        if written > limit.saturating_sub(output.len()) {
            return Err(CodecError::limits(
                "packed transaction inflation exceeds limit",
            ));
        }
        output.extend_from_slice(&chunk[..written]);
        if status == Status::StreamEnd {
            if decoder.total_in() != bytes.len() as u64 {
                return Err(CodecError::value(
                    "trailing compressed packed transaction bytes",
                ));
            }
            return Ok(output);
        }
        if decoder.total_in() == before_in && decoder.total_out() == before_out {
            return Err(CodecError::value(
                "incomplete compressed packed transaction",
            ));
        }
    }
}

fn packed_ids(
    schema: &Value,
    block: &Value,
    profile: &CodecProfile,
) -> Result<HashSet<String>, CodecError> {
    let mut result = HashSet::new();
    let mut total_bytes = 0usize;
    for receipt in array(&block["transactions"])? {
        let packed = &receipt["trx"];
        object(packed)?;
        let raw = unhex(string(&packed["packed_trx"])?)?;
        let remaining = MAX_BYTES.saturating_sub(total_bytes);
        let bytes = match packed["compression"].as_u64() {
            Some(0) => raw,
            Some(1) => inflate(&raw, MAX_PACKED_BYTES.min(remaining))?,
            _ => {
                return Err(CodecError::unsupported(
                    "unknown packed transaction compression",
                ));
            }
        };
        if bytes.len() > MAX_PACKED_BYTES || bytes.len() > remaining {
            return Err(CodecError::limits(
                "packed transaction membership exceeds limit",
            ));
        }
        total_bytes += bytes.len();
        // Native transaction::id hashes the repacked object, rather than an
        // arbitrary incoming encoding. Never infer absence from unchecked bytes.
        let decoded = decode_value(schema, "transaction", &bytes, profile)?;
        if encode_value(schema, "transaction", &decoded, profile)? != bytes {
            return Err(CodecError::value(
                "noncanonical packed transaction membership",
            ));
        }
        if !result.insert(sha256(&bytes)) {
            return Err(CodecError::value("duplicate packed transaction membership"));
        }
    }
    Ok(result)
}

fn implicit_partial() -> Value {
    json!(["partial_transaction_v0", {"expiration":"1970-01-01T00:00:00", "ref_block_num":0,
        "ref_block_prefix":0,"max_net_usage_words":0,"max_cpu_usage_ms":0,"delay_sec":0,
        "transaction_extensions":[],"signatures":[],"context_free_data":[]}])
}

fn verify_candidate(
    schema: &Value,
    block: &Value,
    transaction: &Value,
    action: &Value,
    source: &Value,
    profile: &CodecProfile,
) -> Result<(), CodecError> {
    if action["action_ordinal"].as_u64() != Some(1)
        || action["creator_action_ordinal"].as_u64() != Some(0)
        || action["receiver"] != "sysio"
        || action["context_free"].as_u64() != Some(0)
        || action["act"]["account"] != "sysio"
        || action["act"]["name"] != "onblock"
        || action["act"]["authorization"] != json!([{"actor":"sysio","permission":"active"}])
        || transaction["partial"] != implicit_partial()
    {
        return Err(CodecError::value(
            "native implicit occurrence shape mismatch",
        ));
    }
    let roots = array(&transaction["action_traces"])?
        .iter()
        .map(|value| {
            let value =
                variant(value, "action_trace_v1").or_else(|_| variant(value, "action_trace_v0"))?;
            Ok(value["creator_action_ordinal"].as_u64() == Some(0))
        })
        .collect::<Result<Vec<_>, CodecError>>()?;
    if roots.iter().filter(|root| **root).count() != 1 {
        return Err(CodecError::value(
            "implicit transaction has additional roots",
        ));
    }
    let bytes = unhex(string(&action["act"]["data"])?)?;
    let native = decode_native_value(ONBLOCK_KIND, &bytes, profile)?;
    if encode_native_value(ONBLOCK_KIND, &native, profile)? != bytes {
        return Err(CodecError::value("native header does not round trip"));
    }
    let (previous_id, previous_number) = header_id(native_abi(), &native["header"], profile)?;
    if previous_id != source["previousBlockId"]
        || Some(u64::from(previous_number) + 1) != source["blockNum"].as_u64()
    {
        return Err(CodecError::value("native predecessor header mismatch"));
    }
    let implicit = json!({"expiration":"1970-01-01T00:00:00", "ref_block_num":0,"ref_block_prefix":0,
        "max_net_usage_words":0,"max_cpu_usage_ms":0,"delay_sec":0,"context_free_actions":[],
        "actions":[action["act"].clone()],"transaction_extensions":[]});
    let id = sha256(&encode_value(schema, "transaction", &implicit, profile)?);
    if id != transaction["id"] {
        return Err(CodecError::value("native implicit transaction ID mismatch"));
    }
    if packed_ids(schema, block, profile)?.contains(&id) {
        return Err(CodecError::value(
            "implicit transaction contradicts packed user membership",
        ));
    }
    Ok(())
}

/// Decode a native kind without consulting any contract ABI or deployment state.
pub fn decode_native_value(
    kind: &str,
    bytes: &[u8],
    profile: &CodecProfile,
) -> Result<Value, CodecError> {
    profile_supported(profile)?;
    if kind != ONBLOCK_KIND {
        return Err(CodecError::unsupported("unknown native action kind"));
    }
    decode_value(native_abi(), "wire_native_onblock_v1", bytes, profile)
}

/// Encode the original action shape, including its `header` wrapper, strictly.
pub fn encode_native_value(
    kind: &str,
    value: &Value,
    profile: &CodecProfile,
) -> Result<Vec<u8>, CodecError> {
    profile_supported(profile)?;
    if kind != ONBLOCK_KIND {
        return Err(CodecError::unsupported("unknown native action kind"));
    }
    encode_value(native_abi(), "wire_native_onblock_v1", value, profile)
}

/// JSON boundary: original sections are `{schemaJson, blockHex, tracesHex}`.
///
/// Global source/framing errors throw. Candidate-only failures yield a detached
/// incomplete decision and never change ordinary origins or fall back to an ABI.
pub fn observe_native_actions(
    input: &Value,
    source: &Value,
    profile: &CodecProfile,
) -> Result<Value, CodecError> {
    profile_supported(profile)?;
    check_json(source)?;
    exact_fields(object(input)?, &["schemaJson", "blockHex", "tracesHex"])?;
    exact_fields(
        object(source)?,
        &["chainId", "blockNum", "blockId", "previousBlockId"],
    )?;
    digest(&source["chainId"])?;
    digest(&source["blockId"])?;
    digest(&source["previousBlockId"])?;
    let number = source["blockNum"]
        .as_u64()
        .filter(|number| (2..=u64::from(u32::MAX)).contains(number))
        .ok_or_else(|| CodecError::value("native source requires block number at least two"))?;
    let schema_json = string(&input["schemaJson"])?;
    if schema_json.len() > MAX_SCHEMA_BYTES {
        return Err(CodecError::limits("native schema text exceeds limit"));
    }
    if sha256(schema_json.as_bytes()) != SCHEMA_SHA256 {
        return Err(CodecError::abi(
            "native schema does not match pinned source",
        ));
    }
    let schema: Value = serde_json::from_str(schema_json)
        .map_err(|_| CodecError::abi("invalid native schema JSON"))?;
    let block = decode_value(
        &schema,
        "signed_block",
        &unhex(string(&input["blockHex"])?)?,
        profile,
    )?;
    let (id, decoded_number) = header_id(&schema, &header(&block)?, profile)?;
    if id != source["blockId"]
        || u64::from(decoded_number) != number
        || block["previous"] != source["previousBlockId"]
    {
        return Err(CodecError::value("native block/source position mismatch"));
    }
    let traces = decode_value(
        &schema,
        "transaction_trace[]",
        &unhex(string(&input["tracesHex"])?)?,
        profile,
    )?;
    let facts = observe_block_abi(&json!({"traces":traces,"accountRows":[]}), source, profile)?;
    let transaction = variant(
        array(&traces)?
            .first()
            .ok_or_else(|| CodecError::value("native implicit trace missing"))?,
        "transaction_trace_v0",
    )?;
    let raw_action = array(&transaction["action_traces"])?
        .first()
        .ok_or_else(|| CodecError::value("native implicit action missing"))?;
    let action = variant(raw_action, "action_trace_v1")
        .or_else(|_| variant(raw_action, "action_trace_v0"))?;
    let mut candidate_found = false;
    let mut decisions = Vec::new();
    for input in array(&facts["actionInputs"])? {
        if input["actionOrdinal"] != input["inputActionOrdinal"]
            || input["receiver"] != input["account"]
        {
            continue;
        }
        let origin = json!({"transactionId":input["transactionId"],"actionOrdinal":input["actionOrdinal"],
            "rawSha256":sha256(&unhex(string(&input["rawHex"])?)?)});
        if input["transactionId"] == transaction["id"]
            && input["actionOrdinal"] == action["action_ordinal"]
        {
            candidate_found = true;
            match verify_candidate(&schema, &block, transaction, action, source, profile) {
                Ok(()) => decisions
                    .push(json!({"origin":origin,"kind":"native","nativeKind":ONBLOCK_KIND})),
                Err(error) => {
                    let (code, message) = match error.code() {
                        "unsupported_feature" => (
                            "native_source_unsupported",
                            "Unsupported native onblock source semantics",
                        ),
                        "limits_exceeded" => (
                            "native_source_limits",
                            "Native onblock source exceeds verification limits",
                        ),
                        _ => (
                            "native_source_invalid",
                            "Native onblock source verification failed",
                        ),
                    };
                    decisions.push(json!({"origin":origin,"kind":"incomplete","error":{"code":code,"message":message}}));
                }
            }
        } else {
            decisions.push(json!({"origin":origin,"kind":"contract"}));
        }
    }
    if !candidate_found {
        return Err(CodecError::value("native first-receiver origin missing"));
    }
    let result = json!({"schemaVersion":1,"decisions":decisions});
    check_json(&result)?;
    Ok(result)
}
