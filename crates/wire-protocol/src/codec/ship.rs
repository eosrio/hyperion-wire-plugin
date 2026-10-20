//! Explicit correction of the evidenced Wire resource_index table-count bug.
//! Generic value decoding still rejects the original trailing bytes.
use super::{CodecError, CodecProfile, MAX_BYTES, MAX_ELEMENTS, decode_value};
use serde_json::{Value, json};

pub fn decode_deltas(
    abi: &Value,
    bytes: &[u8],
    profile: &CodecProfile,
) -> Result<Value, CodecError> {
    if bytes.len() > MAX_BYTES {
        return Err(CodecError::limits("delta byte limit"));
    }
    let mut count = 0usize;
    let mut prefix = 0;
    for i in 0..5 {
        let b = *bytes
            .get(i)
            .ok_or_else(|| CodecError::value("missing delta count"))?;
        if i == 4 && b > 15 {
            return Err(CodecError::value("delta count overflow"));
        }
        count |= ((b & 127) as usize) << (7 * i);
        if b & 128 == 0 {
            if i > 0 && b == 0 {
                return Err(CodecError::value("noncanonical delta count"));
            }
            prefix = i + 1;
            break;
        }
    }
    if prefix == 0 {
        return Err(CodecError::value("unterminated delta count"));
    }
    if count > MAX_ELEMENTS {
        return Err(CodecError::limits("delta count limit"));
    }
    match decode_value(abi, "table_delta[]", bytes, profile) {
        Ok(deltas) => {
            return Ok(
                json!({"deltas": deltas, "framing": {"declaredCount":count,"actualCount":count,"compatibility":null}}),
            );
        }
        Err(e) if e.code() == "invalid_value" => {}
        Err(e) => return Err(e),
    }
    let known = CodecProfile::for_id(&profile.id)?;
    if known.upstream_revision != profile.upstream_revision {
        return Err(CodecError::unsupported("unknown delta profile"));
    }
    if count >= MAX_ELEMENTS {
        return Err(CodecError::limits("delta count limit"));
    }
    let mut corrected = Vec::with_capacity(bytes.len() + 1);
    let mut n = count + 1;
    loop {
        let b = (n & 127) as u8;
        n >>= 7;
        corrected.push(b | if n > 0 { 128 } else { 0 });
        if n == 0 {
            break;
        }
    }
    corrected.extend_from_slice(&bytes[prefix..]);
    let deltas = decode_value(abi, "table_delta[]", &corrected, profile)?;
    let items = deltas
        .as_array()
        .ok_or_else(|| CodecError::value("invalid delta array"))?;
    let order = [
        "account",
        "account_metadata",
        "code",
        "contract_row_kv",
        "contract_index_kv",
        "global_property",
        "protocol_state",
        "permission",
        "permission_link",
        "resource_limits",
        "resource_usage",
        "resource_limits_state",
        "resource_limits_config",
    ];
    let mut previous: Option<usize> = None;
    let mut names = Vec::new();
    for delta in items {
        if delta[0] != "table_delta_v0" {
            return Err(CodecError::value("unsupported delta layout"));
        }
        let name = delta[1]["name"]
            .as_str()
            .ok_or_else(|| CodecError::value("missing delta stream"))?;
        let index = order
            .iter()
            .position(|entry| *entry == name)
            .ok_or_else(|| CodecError::value("unknown corrected stream"))?;
        if previous.is_some_and(|p| index <= p) {
            return Err(CodecError::value("incorrect corrected stream ordering"));
        }
        previous = Some(index);
        names.push(name);
    }
    if !names.contains(&"resource_limits") || !names.contains(&"resource_usage") {
        return Err(CodecError::value("missing duplicate resource streams"));
    }
    Ok(
        json!({"deltas":deltas,"framing":{"declaredCount":count,"actualCount":count+1,"compatibility":"wire-resource-index-count-v1"}}),
    )
}
