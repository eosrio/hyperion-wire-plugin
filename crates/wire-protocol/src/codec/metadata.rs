use super::binary::{Reader, Writer, hex, unhex};
use super::scalar::{name_from_u64, name_to_u64, parse_signed, parse_unsigned};
use super::{CodecError, CodecProfile, array, check_json, object, string};
use serde_json::{Map, Value};

// FC_REFLECT order from the pinned node's abi_def.hpp. Trailing may_not_exist
// fields are untagged: only end-of-input means absence, never a presence byte.
const REQUIRED: &[(&str, &str)] = &[
    ("version", "string"),
    ("types", "type_def[]"),
    ("structs", "struct_def[]"),
    ("actions", "action_def[]"),
    ("tables", "table_def[]"),
    ("ricardian_clauses", "clause_pair[]"),
    ("error_messages", "error_message[]"),
    ("abi_extensions", "extension[]"),
];
const OPTIONAL: &[(&str, &str)] = &[
    ("variants", "variant_def[]"),
    ("action_results", "action_result_def[]"),
    ("enums", "enum_def[]"),
    ("protobuf_types", "string"),
];

fn fields(kind: &str) -> Result<&'static [(&'static str, &'static str)], CodecError> {
    Ok(match kind {
        "type_def" => &[("new_type_name", "string"), ("type", "string")],
        "field_def" => &[("name", "string"), ("type", "string")],
        "struct_def" => &[
            ("name", "string"),
            ("base", "string"),
            ("fields", "field_def[]"),
        ],
        "action_def" => &[
            ("name", "name"),
            ("type", "string"),
            ("ricardian_contract", "string"),
        ],
        "index_def" => &[
            ("name", "string"),
            ("key_type", "string"),
            ("table_id", "uint16"),
        ],
        "table_def" => &[
            ("name", "string"),
            ("index_type", "string"),
            ("key_names", "string[]"),
            ("key_types", "string[]"),
            ("type", "string"),
            ("table_id", "uint16"),
            ("secondary_indexes", "index_def[]"),
        ],
        "clause_pair" => &[("id", "string"), ("body", "string")],
        "error_message" => &[("error_code", "uint64"), ("error_msg", "string")],
        "variant_def" => &[("name", "string"), ("types", "string[]")],
        "action_result_def" => &[("name", "name"), ("result_type", "string")],
        "enum_value_def" => &[("name", "string"), ("value", "int64")],
        "enum_def" => &[
            ("name", "string"),
            ("type", "string"),
            ("values", "enum_value_def[]"),
        ],
        _ => return Err(CodecError::abi("unknown metadata kind")),
    })
}

fn read(kind: &str, reader: &mut Reader<'_>) -> Result<Value, CodecError> {
    reader.node()?;
    if let Some(base) = kind.strip_suffix("[]") {
        let count = reader.count()?;
        let mut values = Vec::with_capacity(count.min(1024));
        for _ in 0..count {
            values.push(read(base, reader)?);
        }
        return Ok(Value::Array(values));
    }
    Ok(match kind {
        "string" => Value::String(reader.string()?),
        "name" => Value::String(name_from_u64(u64::from_le_bytes(reader.fixed()?))),
        "uint16" => Value::from(u16::from_le_bytes(reader.fixed()?)),
        "uint64" => Value::String(u64::from_le_bytes(reader.fixed()?).to_string()),
        "int64" => Value::String(i64::from_le_bytes(reader.fixed()?).to_string()),
        "extension" => Value::Array(vec![
            Value::from(u16::from_le_bytes(reader.fixed()?)),
            Value::String(hex(reader.blob()?)),
        ]),
        _ => {
            let mut value = Map::new();
            for (name, kind) in fields(kind)? {
                value.insert((*name).into(), read(kind, reader)?);
            }
            Value::Object(value)
        }
    })
}

fn write(kind: &str, value: &Value, writer: &mut Writer) -> Result<(), CodecError> {
    writer.node()?;
    if let Some(base) = kind.strip_suffix("[]") {
        let values = array(value)?;
        writer.varuint(values.len() as u32)?;
        for value in values {
            write(base, value, writer)?;
        }
        return Ok(());
    }
    match kind {
        "string" => writer.string(string(value)?),
        "name" => writer.write(&name_to_u64(string(value)?)?.to_le_bytes()),
        "uint16" => writer.write(&(parse_unsigned(value, 16)? as u16).to_le_bytes()),
        "uint64" => writer.write(&(parse_unsigned(value, 64)? as u64).to_le_bytes()),
        "int64" => writer.write(&(parse_signed(value, 64)? as i64).to_le_bytes()),
        "extension" => {
            let pair = array(value)?;
            if pair.len() != 2 {
                return Err(CodecError::abi("extension must contain type and bytes"));
            }
            writer.write(&(parse_unsigned(&pair[0], 16)? as u16).to_le_bytes())?;
            writer.blob(&unhex(string(&pair[1])?)?)
        }
        _ => {
            let value = object(value)?;
            let allowed = fields(kind)?;
            if value
                .keys()
                .any(|key| !allowed.iter().any(|(name, _)| key == name))
            {
                return Err(CodecError::unsupported("unknown ABI metadata field"));
            }
            for (name, kind) in allowed {
                let default;
                let item = match value.get(*name) {
                    Some(item) => item,
                    None if kind.ends_with("[]")
                        && matches!(*name, "key_names" | "key_types" | "secondary_indexes") =>
                    {
                        default = Value::Array(vec![]);
                        &default
                    }
                    None if *name == "table_id" => {
                        default = Value::from(0);
                        &default
                    }
                    None if matches!(*name, "base" | "ricardian_contract" | "index_type") => {
                        default = Value::String(String::new());
                        &default
                    }
                    None => return Err(CodecError::abi(format!("missing metadata field {name}"))),
                };
                write(kind, item, writer)?;
            }
            Ok(())
        }
    }
}

fn version(abi: &Value) -> Result<(), CodecError> {
    if !abi["version"].as_str().is_some_and(|v| {
        matches!(
            v,
            "sysio::abi/1.0" | "sysio::abi/1.1" | "sysio::abi/1.2" | "sysio::abi/1.3"
        )
    }) {
        return Err(CodecError::unsupported("unsupported Wire meta-ABI version"));
    }
    Ok(())
}

fn descriptor_text(abi: &Value) -> Result<(), CodecError> {
    if let Some(Value::String(raw)) = abi.get("protobuf_types")
        && !raw.is_empty()
    {
        let descriptor: Value = serde_json::from_str(raw)
            .map_err(|_| CodecError::abi("invalid protobuf descriptor JSON"))?;
        if !descriptor.is_object() && !descriptor.is_array() && !descriptor.is_null() {
            return Err(CodecError::abi(
                "protobuf descriptor JSON must be an object",
            ));
        }
        check_json(&descriptor)?;
    }
    Ok(())
}

/// Decode the full Wire metadata layout, preserving absent tails and descriptor JSON text.
pub fn decode_abi(bytes: &[u8], profile: &CodecProfile) -> Result<Value, CodecError> {
    (|| {
        profile.validate()?;
        let mut reader = Reader::new(bytes)?;
        let mut abi = Map::new();
        for (name, kind) in REQUIRED {
            abi.insert((*name).into(), read(kind, &mut reader)?);
        }
        for (name, kind) in OPTIONAL {
            if reader.remaining() == 0 {
                break;
            }
            abi.insert((*name).into(), read(kind, &mut reader)?);
        }
        if reader.remaining() != 0 {
            return Err(CodecError::unsupported("unknown trailing Wire ABI layout"));
        }
        let abi = Value::Object(abi);
        version(&abi)?;
        descriptor_text(&abi)?;
        check_json(&abi)?;
        Ok(abi)
    })()
    .map_err(CodecError::into_abi)
}

/// Encode in source field order. Omitted earlier tails are filled only when a later tail exists.
pub fn encode_abi(abi: &Value, profile: &CodecProfile) -> Result<Vec<u8>, CodecError> {
    (|| {
        profile.validate()?;
        check_json(abi)?;
        version(abi)?;
        descriptor_text(abi)?;
        let abi = object(abi)?;
        if abi.keys().any(|key| {
            key != "____comment" && !REQUIRED.iter().chain(OPTIONAL).any(|(name, _)| key == name)
        }) {
            return Err(CodecError::unsupported("unknown ABI metadata field"));
        }
        let mut writer = Writer::new();
        for (name, kind) in REQUIRED {
            let default = Value::Array(vec![]);
            let value = abi.get(*name).unwrap_or(&default);
            write(kind, value, &mut writer)?;
        }
        let last = OPTIONAL
            .iter()
            .rposition(|(name, _)| abi.contains_key(*name));
        if let Some(last) = last {
            for (name, kind) in &OPTIONAL[..=last] {
                let default = if *kind == "string" {
                    Value::String(String::new())
                } else {
                    Value::Array(vec![])
                };
                let value = abi.get(*name).unwrap_or(&default);
                if *name == "protobuf_types" && value.is_object() {
                    writer.string(
                        &serde_json::to_string(value)
                            .map_err(|_| CodecError::abi("invalid descriptor JSON"))?,
                    )?;
                } else {
                    write(kind, value, &mut writer)?;
                }
            }
        }
        Ok(writer.bytes)
    })()
    .map_err(CodecError::into_abi)
}
