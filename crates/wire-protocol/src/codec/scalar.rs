use super::binary::{Reader, Writer, hex, unhex};
use super::{CodecError, CodecProfile, string};
use base64::Engine;
use chrono::{Datelike, NaiveDateTime, TimeZone, Utc};
use k256::elliptic_curve::sec1::ToEncodedPoint;
use ripemd::{Digest, Ripemd160};
use serde_json::{Value, json};

pub(crate) fn is_builtin(kind: &str, profile: &CodecProfile) -> bool {
    matches!(
        kind,
        "bool"
            | "int8"
            | "uint8"
            | "int16"
            | "uint16"
            | "int32"
            | "uint32"
            | "int64"
            | "uint64"
            | "int128"
            | "uint128"
            | "varint32"
            | "varuint32"
            | "varint_int64"
            | "varint_uint64"
            | "float32"
            | "float64"
            | "float128"
            | "time_point"
            | "time_point_sec"
            | "block_timestamp_type"
            | "name"
            | "bytes"
            | "string"
            | "checksum160"
            | "checksum256"
            | "checksum512"
            | "public_key"
            | "signature"
            | "symbol"
            | "symbol_code"
            | "asset"
            | "extended_asset"
            | "bitset"
    ) || kind == "slug_name" && profile.slug_name_builtin
}

pub(crate) fn parse_unsigned(value: &Value, bits: u32) -> Result<u128, CodecError> {
    let number = if let Some(text) = value.as_str() {
        let text = if text == "-0" { "0" } else { text };
        if text.is_empty()
            || text.len() > 1 && text.starts_with('0')
            || !text.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(CodecError::value("expected unsigned decimal"));
        }
        text.parse::<u128>()
            .map_err(|_| CodecError::value("unsigned integer overflow"))?
    } else if let Some(number) = value.as_u64() {
        if number > 9_007_199_254_740_991 {
            return Err(CodecError::value("unsafe JSON integer"));
        }
        u128::from(number)
    } else if let Some(number) = value
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && *n <= 9_007_199_254_740_991.0)
    {
        number as u128
    } else {
        return Err(CodecError::value("expected unsigned integer"));
    };
    if bits < 128 && number >= (1u128 << bits) {
        return Err(CodecError::value("unsigned integer out of range"));
    }
    Ok(number)
}
pub(crate) fn parse_signed(value: &Value, bits: u32) -> Result<i128, CodecError> {
    let number = if let Some(text) = value.as_str() {
        let digits = text.strip_prefix('-').unwrap_or(text);
        if digits.is_empty()
            || digits.len() > 1 && digits.starts_with('0')
            || !digits.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(CodecError::value("expected signed decimal"));
        }
        text.parse::<i128>()
            .map_err(|_| CodecError::value("signed integer overflow"))?
    } else if let Some(number) = value.as_i64() {
        if number.unsigned_abs() > 9_007_199_254_740_991 {
            return Err(CodecError::value("unsafe JSON integer"));
        }
        i128::from(number)
    } else if let Some(number) = value
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
    {
        number as i128
    } else {
        return Err(CodecError::value("expected signed integer"));
    };
    if bits < 128 && (number < -(1i128 << (bits - 1)) || number > (1i128 << (bits - 1)) - 1) {
        return Err(CodecError::value("signed integer out of range"));
    }
    Ok(number)
}

pub(crate) fn name_from_u64(value: u64) -> String {
    const ALPHABET: &[u8] = b".12345abcdefghijklmnopqrstuvwxyz";
    let mut text = String::with_capacity(13);
    for i in 0..13 {
        let shift = if i == 12 { 0 } else { 64 - 5 * (i + 1) };
        let mask = if i == 12 { 15 } else { 31 };
        text.push(ALPHABET[((value >> shift) & mask) as usize] as char);
    }
    text.trim_end_matches('.').into()
}
pub(crate) fn name_to_u64(text: &str) -> Result<u64, CodecError> {
    if !text.is_ascii() || text.len() > 13 || text.ends_with('.') {
        return Err(CodecError::value("invalid name"));
    }
    let alphabet = b".12345abcdefghijklmnopqrstuvwxyz";
    let mut value = 0u64;
    for (i, byte) in text.bytes().enumerate() {
        let symbol = alphabet
            .iter()
            .position(|b| *b == byte)
            .ok_or_else(|| CodecError::value("invalid name character"))?;
        if i == 12 && symbol > 15 {
            return Err(CodecError::value("invalid thirteenth name character"));
        }
        value |= (symbol as u64) << if i == 12 { 0 } else { 64 - 5 * (i + 1) };
    }
    Ok(value)
}

fn slug_from_u64(value: u64) -> String {
    let alphabet = b"\0ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
    let mut text = String::new();
    for i in 0..8 {
        let symbol = ((value >> (42 - 6 * i)) & 63) as usize;
        if symbol == 0 {
            break;
        }
        text.push(alphabet.get(symbol).copied().unwrap_or(0) as char);
    }
    text
}
fn slug_to_u64(value: &Value) -> Result<u64, CodecError> {
    if let Some(object) = value.as_object() {
        if object.len() != 1 {
            return Err(CodecError::value("invalid raw slug carrier"));
        }
        return Ok(parse_unsigned(
            object
                .get("value")
                .ok_or_else(|| CodecError::value("slug object needs value"))?,
            64,
        )? as u64);
    }
    let text = string(value)?;
    if !text.is_ascii()
        || text.len() > 8
        || !text.is_empty() && !text.as_bytes()[0].is_ascii_uppercase()
    {
        return Err(CodecError::value("invalid slug name"));
    }
    let alphabet = b"\0ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
    let mut value = 0;
    for (i, byte) in text.bytes().enumerate() {
        let symbol = alphabet
            .iter()
            .position(|b| *b == byte)
            .filter(|s| *s > 0)
            .ok_or_else(|| CodecError::value("invalid slug character"))?;
        value |= (symbol as u64) << (42 - 6 * i);
    }
    Ok(value)
}

fn format_time(micros: i64, fraction: bool) -> Result<String, CodecError> {
    if micros < 0 {
        let magnitude = micros.unsigned_abs();
        let hours = magnitude / 3_600_000_000;
        let minutes = magnitude / 60_000_000 % 60;
        let seconds = magnitude / 1_000_000 % 60;
        let fraction = magnitude % 1_000_000;
        let mut text = format!("-{hours:02}{minutes:02}{seconds:02}");
        if fraction != 0 {
            text.push_str(&format!(".{fraction:06}"));
        }
        return Ok(text);
    }
    let date = Utc
        .timestamp_micros(micros)
        .single()
        .ok_or_else(|| CodecError::value("timestamp outside supported calendar"))?;
    if !(0..=9999).contains(&date.year()) {
        return Err(CodecError::unsupported(
            "timestamp outside four-digit year range",
        ));
    }
    Ok(if fraction {
        date.format("%Y-%m-%dT%H:%M:%S%.3f").to_string()
    } else {
        date.format("%Y-%m-%dT%H:%M:%S").to_string()
    })
}
fn format_float(value: f64) -> String {
    if value.is_nan() {
        "nan".into()
    } else if value == f64::INFINITY {
        "inf".into()
    } else if value == f64::NEG_INFINITY {
        "-inf".into()
    } else {
        format!("{value:.17}")
    }
}
fn valid_float(text: &str) -> bool {
    if matches!(text, "inf" | "-inf" | "nan") {
        return true;
    }
    let text = text.strip_prefix('-').unwrap_or(text);
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut digits = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        digits += 1;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return false;
    }
    if i < bytes.len() && matches!(bytes[i], b'e' | b'E') {
        i += 1;
        if i < bytes.len() && matches!(bytes[i], b'+' | b'-') {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == bytes.len()
}
fn parse_time(value: &Value, seconds_only: bool) -> Result<i64, CodecError> {
    let text = string(value)?;
    // The package accepts canonical UTC without offsets; no local timezone or clock is consulted.
    let expected = if seconds_only { 19 } else { 23 };
    if text.len() != expected || !text.is_ascii() {
        return Err(CodecError::value("expected canonical UTC timestamp"));
    }
    let bytes = text.as_bytes();
    for (i, byte) in bytes.iter().enumerate() {
        let separator = match i {
            4 | 7 => Some(b'-'),
            10 => Some(b'T'),
            13 | 16 => Some(b':'),
            19 => Some(b'.'),
            _ => None,
        };
        if let Some(separator) = separator {
            if *byte != separator {
                return Err(CodecError::value("invalid timestamp separator"));
            }
        } else if !byte.is_ascii_digit() {
            return Err(CodecError::value("invalid timestamp digit"));
        }
    }
    let date = NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f")
        .map_err(|_| CodecError::value("invalid UTC timestamp"))?;
    let micros = date.and_utc().timestamp_micros();
    if micros >= 0 && format_time(micros, !seconds_only)? != text {
        return Err(CodecError::value("noncanonical UTC timestamp"));
    }
    Ok(micros)
}

fn symbol_from_bytes(bytes: &[u8]) -> Result<String, CodecError> {
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    if end > 7
        || !bytes[..end].iter().all(u8::is_ascii_uppercase)
        || bytes[end..].iter().any(|b| *b != 0)
    {
        return Err(CodecError::value("invalid symbol"));
    }
    Ok(String::from_utf8(bytes[..end].to_vec()).expect("ASCII validated"))
}
fn symbol_bytes(value: &Value, code_only: bool) -> Result<[u8; 8], CodecError> {
    let text = string(value)?;
    let (precision, code) = if code_only {
        (0, text)
    } else {
        let (p, code) = text
            .split_once(',')
            .ok_or_else(|| CodecError::value("expected precision,symbol"))?;
        let precision = p;
        let p = p
            .parse::<u8>()
            .map_err(|_| CodecError::value("invalid symbol precision"))?;
        if p.to_string() != precision {
            return Err(CodecError::value("noncanonical symbol precision"));
        }
        if p > 18 {
            return Err(CodecError::value("symbol precision exceeds 18"));
        }
        (p, code)
    };
    if code.len() > 7 || !code.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(CodecError::value("invalid symbol code"));
    }
    let mut bytes = [0u8; 8];
    if code_only {
        bytes[..code.len()].copy_from_slice(code.as_bytes());
    } else {
        bytes[0] = precision;
        bytes[1..code.len() + 1].copy_from_slice(code.as_bytes());
    }
    Ok(bytes)
}

fn decode_asset(reader: &mut Reader<'_>) -> Result<Value, CodecError> {
    let amount = i64::from_le_bytes(reader.fixed()?);
    if amount.unsigned_abs() > ((1u64 << 62) - 1) {
        return Err(CodecError::value("asset amount exceeds Wire range"));
    }
    let symbol = reader.fixed::<8>()?;
    let precision = symbol[0] as usize;
    if precision > 18 {
        return Err(CodecError::value("asset precision exceeds 18"));
    }
    let code = symbol_from_bytes(&symbol[1..])?;
    let negative = if amount < 0 { "-" } else { "" };
    let digits = amount.unsigned_abs().to_string();
    let quantity = if precision == 0 {
        format!("{negative}{digits}")
    } else {
        let digits = format!("{:0>width$}", digits, width = precision + 1);
        format!(
            "{negative}{}.{}",
            &digits[..digits.len() - precision],
            &digits[digits.len() - precision..]
        )
    };
    Ok(Value::String(format!("{quantity} {code}")))
}
fn encode_asset(value: &Value, writer: &mut Writer) -> Result<(), CodecError> {
    let (quantity, code) = string(value)?
        .split_once(' ')
        .ok_or_else(|| CodecError::value("invalid asset"))?;
    let (negative, quantity) = if let Some(t) = quantity.strip_prefix('-') {
        (true, t)
    } else {
        (false, quantity)
    };
    let (whole, fraction) = quantity.split_once('.').unwrap_or((quantity, ""));
    if whole.is_empty()
        || whole.len() > 1 && whole.starts_with('0')
        || fraction.len() > 18
        || quantity.contains('.') && fraction.is_empty()
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|b| b.is_ascii_digit())
        || code.is_empty()
    {
        return Err(CodecError::value("invalid asset quantity"));
    }
    let amount = format!("{}{}{}", if negative { "-" } else { "" }, whole, fraction)
        .parse::<i64>()
        .map_err(|_| CodecError::value("asset amount overflow"))?;
    if amount.unsigned_abs() > ((1u64 << 62) - 1) {
        return Err(CodecError::value("asset amount exceeds Wire range"));
    }
    writer.write(&amount.to_le_bytes())?;
    writer.write(&symbol_bytes(
        &Value::String(format!("{},{}", fraction.len(), code)),
        false,
    )?)
}

fn checksum(body: &[u8], suffix: &[u8]) -> [u8; 4] {
    let mut digest = Ripemd160::new();
    digest.update(body);
    digest.update(suffix);
    digest.finalize()[..4].try_into().expect("digest size")
}
fn crypto_blob<'a>(reader: &mut Reader<'a>) -> Result<&'a [u8], CodecError> {
    let length = reader.varuint()? as usize;
    if length > 4096 {
        return Err(CodecError::limits("crypto variable frame limit"));
    }
    reader.read(length)
}
fn key_body(reader: &mut Reader<'_>, tag: u32, public: bool) -> Result<Vec<u8>, CodecError> {
    let start = reader.pos;
    match (tag, public) {
        (0 | 1 | 3, true) => {
            reader.read(33)?;
        }
        (0 | 1 | 3, false) => {
            reader.read(65)?;
        }
        (2, true) => {
            reader.read(33)?;
            reader.byte()?;
            let rpid = crypto_blob(reader)?;
            let rpid = std::str::from_utf8(rpid)
                .map_err(|_| CodecError::value("invalid WebAuthn rpid UTF-8"))?;
            if rpid.is_empty() {
                return Err(CodecError::value("WebAuthn rpid must be nonempty"));
            }
        }
        (2, false) => {
            reader.read(65)?;
            crypto_blob(reader)?;
            let client = crypto_blob(reader)?;
            std::str::from_utf8(client)
                .map_err(|_| CodecError::value("invalid WebAuthn client JSON UTF-8"))?;
        }
        (4, true) => {
            reader.read(32)?;
        }
        (4, false) => {
            reader.read(96)?;
        }
        (5, _) => {
            // The ABI variant reflects bls::*_shim's shared_ptr, not the
            // standalone BLS class's length-prefixed stream operator.
            if reader.byte()? != 1 {
                return Err(CodecError::value("invalid BLS pointer presence"));
            }
            reader.read(if public { 96 } else { 192 })?;
        }
        _ => return Err(CodecError::unsupported("unknown Wire crypto variant")),
    }
    if reader.pos - start > 4096 {
        return Err(CodecError::limits("crypto raw frame limit"));
    }
    Ok(reader.bytes[start..reader.pos].to_vec())
}
fn decode_key(reader: &mut Reader<'_>, public: bool) -> Result<Value, CodecError> {
    let tag = reader.varuint()?;
    let mut body = key_body(reader, tag, public)?;
    let prefix = if public { "PUB" } else { "SIG" };
    let suffix = ["K1", "R1", "WA", "EM", "ED", "BLS"]
        .get(tag as usize)
        .ok_or_else(|| CodecError::unsupported("unknown Wire crypto variant"))?;
    let text = match tag {
        0..=2 => {
            body.extend_from_slice(&checksum(&body, suffix.as_bytes()));
            bs58::encode(body).into_string()
        }
        3 if public => {
            let key = k256::PublicKey::from_sec1_bytes(&body)
                .map_err(|_| CodecError::value("invalid EM public point"))?;
            hex(key.to_encoded_point(false).as_bytes())
        }
        3 => format!("0x{}", hex(&body)),
        4 => bs58::encode(body).into_string(),
        5 => {
            let raw = &body[1..];
            let mut checked = raw.to_vec();
            checked.extend_from_slice(&checksum(raw, &[]));
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(checked)
        }
        _ => unreachable!(),
    };
    Ok(Value::String(format!("{prefix}_{suffix}_{text}")))
}
fn encode_key(value: &Value, writer: &mut Writer, public: bool) -> Result<(), CodecError> {
    let text = string(value)?;
    if text.len() > 8200 {
        return Err(CodecError::limits("crypto string byte limit"));
    }
    let prefix = if public { "PUB_" } else { "SIG_" };
    let (tag, encoded, legacy) = if let Some(body) = text.strip_prefix(prefix) {
        let (kind, body) = body
            .split_once('_')
            .ok_or_else(|| CodecError::value("invalid crypto text"))?;
        let tag = ["K1", "R1", "WA", "EM", "ED", "BLS"]
            .iter()
            .position(|s| *s == kind)
            .ok_or_else(|| CodecError::unsupported("unknown crypto text variant"))?
            as u32;
        (tag, body, false)
    } else if public && text.starts_with("SYS") {
        (0, &text[3..], true)
    } else {
        return Err(CodecError::value("invalid crypto text prefix"));
    };
    if encoded.is_empty() {
        return Err(CodecError::value("empty crypto text"));
    }
    if matches!(tag, 0 | 1 | 2 | 4) && encoded.len() > 8192 {
        return Err(CodecError::limits("crypto base58 text limit"));
    }
    let body = match tag {
        0..=2 => {
            let mut checked = bs58::decode(encoded)
                .into_vec()
                .map_err(|_| CodecError::value("invalid base58 crypto text"))?;
            if checked.len() < 4 {
                return Err(CodecError::value("truncated crypto checksum"));
            }
            let check = checked.split_off(checked.len() - 4);
            let suffix = if legacy {
                ""
            } else {
                ["K1", "R1", "WA"][tag as usize]
            };
            if check != checksum(&checked, suffix.as_bytes()) {
                return Err(CodecError::value("crypto checksum mismatch"));
            }
            checked
        }
        3 if public => {
            let mut raw = unhex(encoded.strip_prefix("0x").unwrap_or(encoded))?;
            if raw.len() == 64 {
                raw.insert(0, 4);
            }
            let key = k256::PublicKey::from_sec1_bytes(&raw)
                .map_err(|_| CodecError::value("invalid EM public point"))?;
            key.to_encoded_point(true).as_bytes().to_vec()
        }
        3 => unhex(encoded.strip_prefix("0x").unwrap_or(encoded))?,
        4 => bs58::decode(encoded)
            .into_vec()
            .map_err(|_| CodecError::value("invalid ED base58"))?,
        5 => {
            let checked = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| CodecError::value("invalid BLS base64url"))?;
            if base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&checked) != encoded {
                return Err(CodecError::value("noncanonical BLS base64url"));
            }
            let size = if public { 96 } else { 192 };
            if checked.len() != size + 4 || checked[size..] != checksum(&checked[..size], &[]) {
                return Err(CodecError::value("BLS length/checksum mismatch"));
            }
            let mut body = Writer::new();
            body.byte(1)?;
            body.write(&checked[..size])?;
            body.bytes
        }
        _ => unreachable!(),
    };
    let mut validate = Reader::new(&body)?;
    key_body(&mut validate, tag, public)?;
    validate.end()?;
    writer.varuint(tag)?;
    writer.write(&body)
}

pub(crate) fn decode(
    kind: &str,
    reader: &mut Reader<'_>,
    profile: &CodecProfile,
) -> Result<Value, CodecError> {
    Ok(match kind {
        "bool" | "uint8" => Value::from(reader.byte()?),
        "int8" => Value::from(reader.byte()? as i8),
        "uint16" => Value::from(u16::from_le_bytes(reader.fixed()?)),
        "int16" => Value::from(i16::from_le_bytes(reader.fixed()?)),
        "uint32" => Value::from(u32::from_le_bytes(reader.fixed()?)),
        "int32" => Value::from(i32::from_le_bytes(reader.fixed()?)),
        "uint64" | "varint_uint64" => {
            Value::String(u64::from_le_bytes(reader.fixed()?).to_string())
        }
        "int64" | "varint_int64" => Value::String(i64::from_le_bytes(reader.fixed()?).to_string()),
        "uint128" => Value::String(u128::from_le_bytes(reader.fixed()?).to_string()),
        "int128" => Value::String(i128::from_le_bytes(reader.fixed()?).to_string()),
        "varuint32" => Value::from(reader.varuint()?),
        "varint32" => {
            let v = reader.varuint()?;
            Value::from(((v >> 1) as i32) ^ -((v & 1) as i32))
        }
        "name" => Value::String(name_from_u64(u64::from_le_bytes(reader.fixed()?))),
        "slug_name" if profile.slug_name_builtin => {
            Value::String(slug_from_u64(u64::from_le_bytes(reader.fixed()?)))
        }
        "string" => Value::String(reader.string()?),
        "bytes" => Value::String(hex(reader.blob()?)),
        "checksum160" => Value::String(hex(reader.read(20)?)),
        "checksum256" => Value::String(hex(reader.read(32)?)),
        "checksum512" => Value::String(hex(reader.read(64)?)),
        "float128" => Value::String(format!("0x{}", hex(reader.read(16)?))),
        "float32" => {
            let v = f32::from_le_bytes(reader.fixed()?) as f64;
            Value::String(format_float(v))
        }
        "float64" => {
            let v = f64::from_le_bytes(reader.fixed()?);
            Value::String(format_float(v))
        }
        "time_point" => Value::String(format_time(i64::from_le_bytes(reader.fixed()?), true)?),
        "time_point_sec" => Value::String(format_time(
            i64::from(u32::from_le_bytes(reader.fixed()?)) * 1_000_000,
            false,
        )?),
        "block_timestamp_type" => {
            let slot = i64::from(u32::from_le_bytes(reader.fixed()?));
            let ms = slot
                .checked_mul(profile.slot_milliseconds)
                .and_then(|offset| profile.epoch_milliseconds.checked_add(offset))
                .ok_or_else(|| CodecError::value("timestamp overflow"))?;
            Value::String(format_time(
                ms.checked_mul(1000)
                    .ok_or_else(|| CodecError::value("timestamp overflow"))?,
                true,
            )?)
        }
        "symbol_code" => Value::String(symbol_from_bytes(&reader.fixed::<8>()?)?),
        "symbol" => {
            let b = reader.fixed::<8>()?;
            if b[0] > 18 {
                return Err(CodecError::value("symbol precision exceeds18"));
            }
            Value::String(format!("{},{}", b[0], symbol_from_bytes(&b[1..])?))
        }
        "asset" => decode_asset(reader)?,
        "extended_asset" => {
            let quantity = decode_asset(reader)?;
            let contract = name_from_u64(u64::from_le_bytes(reader.fixed()?));
            json!({"quantity":quantity,"contract":contract})
        }
        "public_key" => decode_key(reader, true)?,
        "signature" => decode_key(reader, false)?,
        "bitset" => {
            let size = reader.count()?;
            let bytes = reader.read(size.div_ceil(8))?;
            Value::String(
                (0..size)
                    .rev()
                    .map(|i| {
                        if bytes[i / 8] & (1 << (i % 8)) == 0 {
                            '0'
                        } else {
                            '1'
                        }
                    })
                    .collect(),
            )
        }
        _ => {
            return Err(CodecError::unsupported(format!(
                "unsupported scalar {kind}"
            )));
        }
    })
}

pub(crate) fn encode(
    kind: &str,
    value: &Value,
    writer: &mut Writer,
    profile: &CodecProfile,
) -> Result<(), CodecError> {
    match kind {
        "bool" => writer.byte(if let Some(value) = value.as_bool() {
            u8::from(value)
        } else {
            parse_unsigned(value, 8)? as u8
        }),
        "uint8" => writer.byte(parse_unsigned(value, 8)? as u8),
        "int8" => writer.byte(parse_signed(value, 8)? as u8),
        "uint16" => writer.write(&(parse_unsigned(value, 16)? as u16).to_le_bytes()),
        "int16" => writer.write(&(parse_signed(value, 16)? as i16).to_le_bytes()),
        "uint32" => writer.write(&(parse_unsigned(value, 32)? as u32).to_le_bytes()),
        "int32" => writer.write(&(parse_signed(value, 32)? as i32).to_le_bytes()),
        "uint64" | "varint_uint64" => {
            writer.write(&(parse_unsigned(value, 64)? as u64).to_le_bytes())
        }
        "int64" | "varint_int64" => writer.write(&(parse_signed(value, 64)? as i64).to_le_bytes()),
        "uint128" => writer.write(&parse_unsigned(value, 128)?.to_le_bytes()),
        "int128" => writer.write(&parse_signed(value, 128)?.to_le_bytes()),
        "varuint32" => writer.varuint(parse_unsigned(value, 32)? as u32),
        "varint32" => {
            let v = parse_signed(value, 32)? as i32;
            writer.varuint(((v as u32) << 1) ^ ((v >> 31) as u32))
        }
        "name" => writer.write(&name_to_u64(string(value)?)?.to_le_bytes()),
        "slug_name" if profile.slug_name_builtin => {
            writer.write(&slug_to_u64(value)?.to_le_bytes())
        }
        "string" => writer.string(string(value)?),
        "bytes" => writer.blob(&unhex(string(value)?)?),
        "checksum160" | "checksum256" | "checksum512" | "float128" => {
            let text = string(value)?;
            let bytes = unhex(if kind == "float128" {
                text.strip_prefix("0x")
                    .ok_or_else(|| CodecError::value("float128 needs 0x prefix"))?
            } else {
                text
            })?;
            let size = match kind {
                "checksum160" => 20,
                "checksum256" => 32,
                "checksum512" => 64,
                _ => 16,
            };
            if bytes.len() != size {
                return Err(CodecError::value("incorrect fixed byte length"));
            }
            writer.write(&bytes)
        }
        "float32" | "float64" => {
            let n = if let Some(n) = value.as_f64() {
                n
            } else {
                let text = string(value)?;
                if !valid_float(text) {
                    return Err(CodecError::value("invalid float carrier"));
                }
                text.parse::<f64>()
                    .map_err(|_| CodecError::value("invalid float"))?
            };
            if kind == "float32" {
                writer.write(&(n as f32).to_le_bytes())
            } else {
                writer.write(&n.to_le_bytes())
            }
        }
        "time_point" => {
            let micros = parse_time(value, false)?;
            if micros < 0 {
                return Err(CodecError::unsupported(
                    "negative time_point uses unsupported duration JSON",
                ));
            }
            writer.write(&micros.to_le_bytes())
        }
        "time_point_sec" => {
            let micros = parse_time(value, true)?;
            if micros < 0 || micros % 1_000_000 != 0 {
                return Err(CodecError::value("unaligned second timestamp"));
            }
            writer.write(
                &u32::try_from(micros / 1_000_000)
                    .map_err(|_| CodecError::value("timestamp range"))?
                    .to_le_bytes(),
            )
        }
        "block_timestamp_type" => {
            let micros = parse_time(value, false)?;
            if micros % 1000 != 0 || profile.slot_milliseconds <= 0 {
                return Err(CodecError::value("unaligned block timestamp"));
            }
            let offset = micros / 1000 - profile.epoch_milliseconds;
            if offset < 0 || offset % profile.slot_milliseconds != 0 {
                return Err(CodecError::value("unaligned block timestamp"));
            }
            writer.write(
                &u32::try_from(offset / profile.slot_milliseconds)
                    .map_err(|_| CodecError::value("block timestamp range"))?
                    .to_le_bytes(),
            )
        }
        "symbol_code" => writer.write(&symbol_bytes(value, true)?),
        "symbol" => writer.write(&symbol_bytes(value, false)?),
        "asset" => encode_asset(value, writer),
        "extended_asset" => {
            let value = super::object(value)?;
            if value.len() != 2 {
                return Err(CodecError::value("invalid extended_asset fields"));
            }
            encode_asset(
                value
                    .get("quantity")
                    .ok_or_else(|| CodecError::value("missing quantity"))?,
                writer,
            )?;
            writer.write(
                &name_to_u64(string(
                    value
                        .get("contract")
                        .ok_or_else(|| CodecError::value("missing contract"))?,
                )?)?
                .to_le_bytes(),
            )
        }
        "public_key" => encode_key(value, writer, true),
        "signature" => encode_key(value, writer, false),
        "bitset" => {
            let text = string(value)?;
            if text.len() > super::MAX_ELEMENTS {
                return Err(CodecError::limits("bitset element limit"));
            }
            let mut bytes = vec![0u8; text.len().div_ceil(8)];
            for (i, c) in text.bytes().rev().enumerate() {
                match c {
                    b'0' => {}
                    b'1' => bytes[i / 8] |= 1 << (i % 8),
                    _ => return Err(CodecError::value("invalid bitset")),
                }
            }
            writer.varuint(text.len() as u32)?;
            writer.write(&bytes)
        }
        _ => Err(CodecError::unsupported(format!(
            "unsupported scalar {kind}"
        ))),
    }
}
