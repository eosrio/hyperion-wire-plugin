//! Package-local Wire engineering primitives, not a complete protocol provider.
//!
//! Inputs are already-decoded SHiP primitives. These functions do not decode binary
//! frames or contract ABIs, resolve deployments, or establish canonical chain state.

use std::fmt;
use std::sync::OnceLock;

use serde_json::{Map, Value, json};

const MAX_SLOT: u64 = u32::MAX as u64;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const ROW_FIELDS: &[&str] = &[
    "kind", "present", "code", "payer", "tableId", "keyHex", "valueHex",
];
const INDEX_FIELDS: &[&str] = &[
    "kind",
    "present",
    "code",
    "payer",
    "tableId",
    "secondaryKeyHex",
    "primaryKeyHex",
];
const SOURCE_FIELDS: &[&str] = &["chainId", "blockId", "blockNum", "ordinal", "abiDeployment"];

/// The reviewed source profile is an engineering fixture, not a testnet release pin.
pub fn protocol_profile() -> &'static Value {
    static PROFILE: OnceLock<Value> = OnceLock::new();
    PROFILE.get_or_init(|| {
        serde_json::from_str(include_str!("../../../protocol-profile.json"))
            .expect("the bundled engineering protocol profile must be valid JSON")
    })
}

fn timestamp_parameters() -> (u64, u64) {
    let profile = protocol_profile();
    let epoch = profile["epochMilliseconds"]
        .as_u64()
        .expect("the bundled profile declares an integer epoch");
    let interval = profile["slotMilliseconds"]
        .as_u64()
        .filter(|interval| *interval != 0)
        .expect("the bundled profile declares a positive integer slot interval");
    (epoch, interval)
}

/// Input-validation failures shared with the Node component.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtocolError {
    InvalidSlot,
    InvalidTimestamp,
    InvalidRecord,
    InvalidSource,
}

impl ProtocolError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidSlot => "invalid_slot",
            Self::InvalidTimestamp => "invalid_timestamp",
            Self::InvalidRecord => "invalid_record",
            Self::InvalidSource => "invalid_source",
        }
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for ProtocolError {}

/// Convert one integer uint32 slot using the bundled Wire timestamp profile.
pub fn slot_to_unix_milliseconds(slot: &Value) -> Result<u64, ProtocolError> {
    let slot = integer(slot, 0, MAX_SLOT).ok_or(ProtocolError::InvalidSlot)?;
    let (epoch, interval) = timestamp_parameters();
    slot.checked_mul(interval)
        .and_then(|offset| epoch.checked_add(offset))
        .filter(|ms| *ms <= MAX_SAFE_INTEGER)
        .ok_or(ProtocolError::InvalidSlot)
}

/// Reject timestamps outside the uint32 range or between two Wire slots.
pub fn unix_milliseconds_to_slot(ms: &Value) -> Result<u32, ProtocolError> {
    let (epoch, interval) = timestamp_parameters();
    let max = MAX_SLOT
        .checked_mul(interval)
        .and_then(|offset| epoch.checked_add(offset))
        .filter(|max| *max <= MAX_SAFE_INTEGER)
        .ok_or(ProtocolError::InvalidTimestamp)?;
    let ms = integer(ms, epoch, max).ok_or(ProtocolError::InvalidTimestamp)?;
    let offset = ms - epoch;
    if offset % interval != 0 {
        return Err(ProtocolError::InvalidTimestamp);
    }
    Ok((offset / interval) as u32)
}

/// Preserve complete row/index bytes and provenance under a chain-scoped identity.
///
/// Record validation precedes source validation when both are malformed. Provenance
/// is retained, but block/deployment fields are deliberately not identity components.
pub fn normalize_kv_record(record: &Value, source: &Value) -> Result<Value, ProtocolError> {
    let r = record.as_object().ok_or(ProtocolError::InvalidRecord)?;
    let kind = text(r, "kind").ok_or(ProtocolError::InvalidRecord)?;
    let fields = match kind {
        "contract_row_kv" => ROW_FIELDS,
        "contract_index_kv" => INDEX_FIELDS,
        _ => return Err(ProtocolError::InvalidRecord),
    };
    if !exact_fields(r, fields)
        || !r["present"].is_boolean()
        || !unsigned_decimal(r.get("code"))
        || !unsigned_decimal(r.get("payer"))
        || integer(&r["tableId"], 0, u16::MAX.into()).is_none()
    {
        return Err(ProtocolError::InvalidRecord);
    }
    match kind {
        "contract_row_kv" if !hex_field(r, "keyHex", None) || !hex_field(r, "valueHex", None) => {
            return Err(ProtocolError::InvalidRecord);
        }
        "contract_index_kv"
            if !hex_field(r, "secondaryKeyHex", None) || !hex_field(r, "primaryKeyHex", None) =>
        {
            return Err(ProtocolError::InvalidRecord);
        }
        _ => {}
    }

    let s = source.as_object().ok_or(ProtocolError::InvalidSource)?;
    if !exact_fields(s, SOURCE_FIELDS)
        || !hex_field(s, "chainId", Some(64))
        || !hex_field(s, "blockId", Some(64))
        || integer(&s["blockNum"], 1, MAX_SLOT).is_none()
        || integer(&s["ordinal"], 0, MAX_SLOT).is_none()
        || !text(s, "abiDeployment").is_some_and(valid_deployment)
    {
        return Err(ProtocolError::InvalidSource);
    }

    // Every component has been validated as delimiter-free canonical text, or an
    // integer. Keep all key bytes, including empty components and compound keys.
    let chain_id = text(s, "chainId").unwrap();
    let code = text(r, "code").unwrap();
    let table_id = integer(&r["tableId"], 0, u16::MAX.into()).unwrap();
    let identity = if kind == "contract_row_kv" {
        format!(
            "wire-kv-v1:row:{chain_id}:{code}:{table_id}:{}",
            text(r, "keyHex").unwrap()
        )
    } else {
        format!(
            "wire-kv-v1:index:{chain_id}:{code}:{table_id}:{}:{}",
            text(r, "secondaryKeyHex").unwrap(),
            text(r, "primaryKeyHex").unwrap()
        )
    };
    Ok(json!({ "identity": identity, "record": record, "source": source }))
}

fn integer(value: &Value, min: u64, max: u64) -> Option<u64> {
    // JSON numbers such as 1.0 and -0 are integers in JavaScript. Validate the
    // finite safe-number domain before conversion so both components agree.
    let number = value.as_f64()?;
    if !number.is_finite()
        || number.fract() != 0.0
        || number < min as f64
        || number > max.min(MAX_SAFE_INTEGER) as f64
    {
        return None;
    }
    Some(number as u64)
}

fn exact_fields(object: &Map<String, Value>, fields: &[&str]) -> bool {
    object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field))
}

fn text<'a>(object: &'a Map<String, Value>, field: &str) -> Option<&'a str> {
    object.get(field)?.as_str()
}

fn unsigned_decimal(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|value| {
        !value.is_empty()
            && (value == "0" || !value.starts_with('0'))
            && value.bytes().all(|b| b.is_ascii_digit())
            && value.parse::<u64>().is_ok()
    })
}

fn hex_field(object: &Map<String, Value>, field: &str, length: Option<usize>) -> bool {
    text(object, field).is_some_and(|value| {
        value.len() % 2 == 0
            && length.is_none_or(|length| value.len() == length)
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn valid_deployment(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with(boundary_whitespace)
        && !value.ends_with(boundary_whitespace)
}

fn boundary_whitespace(c: char) -> bool {
    matches!(c,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{0085}' | '\u{00a0}' |
        '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' |
        '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// Run one package-local fixture operation, returning portable JSON.
pub fn run_operation(operation: &str, input: &Value) -> Result<Value, ProtocolError> {
    match operation {
        "slotToUnixMilliseconds" => slot_to_unix_milliseconds(input).map(Value::from),
        "unixMillisecondsToSlot" => unix_milliseconds_to_slot(input).map(Value::from),
        "normalizeKvRecord" => normalize_kv_record(&input["record"], &input["source"]),
        _ => Err(ProtocolError::InvalidRecord),
    }
}
