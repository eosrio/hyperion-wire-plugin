use super::binary::{Reader, Writer};
use super::protobuf::Protobuf;
use super::scalar;
use super::{CodecError, CodecProfile, MAX_DEPTH, MAX_ELEMENTS, array, check_json, object, string};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

struct Schema<'a> {
    aliases: HashMap<&'a str, &'a str>,
    structs: HashMap<&'a str, &'a Value>,
    variants: HashMap<&'a str, &'a Value>,
    enums: HashMap<&'a str, &'a Value>,
    protobuf: Protobuf,
    profile: &'a CodecProfile,
}

fn records<'a>(abi: &'a Value, field: &str) -> Result<&'a [Value], CodecError> {
    match abi.get(field) {
        Some(value) => array(value).map_err(CodecError::into_abi),
        None => Ok(&[]),
    }
}
fn text<'a>(record: &'a Value, field: &str) -> Result<&'a str, CodecError> {
    if field == "base" && record.get(field).is_none() {
        return Ok("");
    }
    record
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| CodecError::abi(format!("missing ABI string {field}")))
}
fn fixed_array(kind: &str) -> Result<Option<(&str, usize)>, CodecError> {
    if !kind.ends_with(']') || kind.ends_with("[]") {
        return Ok(None);
    }
    let (base, size) = kind[..kind.len() - 1]
        .rsplit_once('[')
        .ok_or_else(|| CodecError::abi("malformed fixed array"))?;
    if size.is_empty() || !size.bytes().all(|b| b.is_ascii_digit()) {
        return Err(CodecError::abi("invalid fixed array size"));
    }
    let size = size
        .parse::<usize>()
        .map_err(|_| CodecError::limits("fixed array size overflow"))?;
    if size > MAX_ELEMENTS {
        return Err(CodecError::limits("fixed array element limit"));
    }
    Ok(Some((base, size)))
}

impl<'a> Schema<'a> {
    fn new(abi: &'a Value, profile: &'a CodecProfile) -> Result<Self, CodecError> {
        profile.validate()?;
        super::metadata::encode_abi(abi, profile)?;
        check_json(abi)?;
        object(abi).map_err(CodecError::into_abi)?;
        let version = text(abi, "version")?;
        // Only explicitly supported Wire metadata versions are interpreted.
        if !matches!(
            version,
            "sysio::abi/1.0" | "sysio::abi/1.1" | "sysio::abi/1.2" | "sysio::abi/1.3"
        ) {
            return Err(CodecError::unsupported("unsupported ABI version"));
        }
        let mut schema = Self {
            aliases: HashMap::new(),
            structs: HashMap::new(),
            variants: HashMap::new(),
            enums: HashMap::new(),
            protobuf: Protobuf::new(abi)?,
            profile,
        };
        let mut names = HashSet::new();
        for field in ["types", "structs", "variants", "enums"] {
            for record in records(abi, field)? {
                let name = text(
                    record,
                    if field == "types" {
                        "new_type_name"
                    } else {
                        "name"
                    },
                )?;
                let reflected_builtin = field == "structs";
                if name.is_empty()
                    || scalar::is_builtin(name, profile) && !reflected_builtin
                    || !names.insert(name)
                    || name.contains(['[', ']', '?', '$'])
                {
                    return Err(CodecError::abi("duplicate or reserved ABI type"));
                }
                match field {
                    "types" => {
                        schema.aliases.insert(name, text(record, "type")?);
                    }
                    "structs" => {
                        schema.structs.insert(name, record);
                    }
                    "variants" => {
                        schema.variants.insert(name, record);
                    }
                    _ => {
                        schema.enums.insert(name, record);
                    }
                }
            }
        }
        for name in schema.aliases.keys() {
            schema.validate_type(name, 0)?;
        }
        for (name, record) in &schema.structs {
            let base = text(record, "base")?;
            if !base.is_empty() && !schema.structs.contains_key(schema.resolve(base)?) {
                return Err(CodecError::abi("struct base must be a struct"));
            }
            let mut fields = Vec::new();
            schema.fields(name, &mut fields, 0)?;
            let mut seen = HashSet::new();
            let mut extension = false;
            for field in fields {
                let name = text(field, "name")?;
                let kind = text(field, "type")?;
                if name.is_empty() || !seen.insert(name) {
                    return Err(CodecError::abi("duplicate/empty struct field"));
                }
                if extension && !kind.ends_with('$') {
                    return Err(CodecError::abi("binary extensions must be trailing fields"));
                }
                extension |= kind.ends_with('$');
                schema.validate_type(kind, 0)?;
            }
        }
        for record in schema.variants.values() {
            let types = array(
                record
                    .get("types")
                    .ok_or_else(|| CodecError::abi("missing variant types"))?,
            )
            .map_err(CodecError::into_abi)?;
            let mut seen = HashSet::new();
            if types.is_empty() {
                return Err(CodecError::abi("empty variant"));
            }
            for kind in types {
                let kind = string(kind).map_err(CodecError::into_abi)?;
                if !seen.insert(kind) {
                    return Err(CodecError::abi("duplicate variant type"));
                }
                schema.validate_type(kind, 0)?;
            }
        }
        for record in schema.enums.values() {
            let underlying = text(record, "type")?;
            let bits = underlying
                .strip_prefix("uint")
                .or_else(|| underlying.strip_prefix("int"))
                .and_then(|s| s.parse::<u32>().ok())
                .filter(|b| matches!(*b, 8 | 16 | 32 | 64 | 128))
                .ok_or_else(|| CodecError::abi("enum requires fixed-width integer"))?;
            let signed = underlying.starts_with("int");
            let mut seen_names = HashSet::new();
            let mut seen_values = HashSet::new();
            for member in records(record, "values")? {
                let name = text(member, "name")?;
                let v = member
                    .get("value")
                    .ok_or_else(|| CodecError::abi("missing enum member value"))?;
                let value = scalar::parse_signed(v, 64).map_err(CodecError::into_abi)?;
                if signed {
                    scalar::parse_signed(v, bits).map_err(CodecError::into_abi)?;
                } else {
                    scalar::parse_unsigned(v, bits).map_err(CodecError::into_abi)?;
                }
                if name.is_empty() || !seen_names.insert(name) || !seen_values.insert(value) {
                    return Err(CodecError::abi("duplicate enum member"));
                }
            }
        }
        for (field, type_field) in [
            ("actions", "type"),
            ("tables", "type"),
            ("action_results", "result_type"),
        ] {
            let mut seen = HashSet::new();
            for record in records(abi, field)? {
                if !seen.insert(text(record, "name")?) {
                    return Err(CodecError::abi("duplicate action/table/result name"));
                }
                schema.validate_type(text(record, type_field)?, 0)?;
            }
        }
        Ok(schema)
    }
    fn resolve<'b>(&'b self, mut kind: &'b str) -> Result<&'b str, CodecError> {
        let mut seen = HashSet::new();
        while let Some(target) = self.aliases.get(kind) {
            if !seen.insert(kind) {
                return Err(CodecError::abi("cyclic ABI typedef"));
            }
            kind = target;
            if seen.len() > MAX_DEPTH {
                return Err(CodecError::limits("typedef depth limit"));
            }
        }
        Ok(kind)
    }
    fn validate_type(&self, kind: &str, depth: usize) -> Result<(), CodecError> {
        if kind.is_empty() || kind.len() > 1024 {
            return Err(CodecError::abi("invalid ABI type name"));
        }
        if depth > MAX_DEPTH {
            return Err(CodecError::limits("ABI type depth limit"));
        }
        let kind = self.resolve(kind)?;
        if let Some(base) = kind
            .strip_suffix('$')
            .or_else(|| kind.strip_suffix('?'))
            .or_else(|| kind.strip_suffix("[]"))
        {
            return self.validate_type(base, depth + 1);
        }
        if let Some((base, _)) = fixed_array(kind)? {
            return self.validate_type(base, depth + 1);
        }
        if kind.starts_with("protobuf::") {
            self.protobuf.descriptor(kind)?;
            return Ok(());
        }
        if scalar::is_builtin(kind, self.profile)
            || self.structs.contains_key(kind)
            || self.variants.contains_key(kind)
            || self.enums.contains_key(kind)
        {
            Ok(())
        } else {
            Err(CodecError::unsupported(format!("unknown ABI type {kind}")))
        }
    }
    fn fields(&self, kind: &str, out: &mut Vec<&'a Value>, depth: usize) -> Result<(), CodecError> {
        if depth > MAX_DEPTH {
            return Err(CodecError::abi("cyclic/deep struct inheritance"));
        }
        let kind = self.resolve(kind)?;
        let record = self
            .structs
            .get(kind)
            .ok_or_else(|| CodecError::abi("unknown base struct"))?;
        let base = text(record, "base")?;
        if !base.is_empty() {
            self.fields(base, out, depth + 1)?;
        }
        out.extend(records(record, "fields")?);
        if out.len() > MAX_ELEMENTS {
            return Err(CodecError::limits("struct field limit"));
        }
        Ok(())
    }

    fn decode(
        &self,
        kind: &str,
        reader: &mut Reader<'_>,
        depth: usize,
        extensions: bool,
    ) -> Result<Value, CodecError> {
        reader.node()?;
        if depth > MAX_DEPTH {
            return Err(CodecError::limits("value recursion limit"));
        }
        let kind = self.resolve(kind)?;
        if let Some(base) = kind.strip_suffix('$') {
            return self.decode(base, reader, depth + 1, extensions);
        }
        if let Some(base) = kind.strip_suffix('?') {
            return match reader.byte()? {
                0 => Ok(Value::Null),
                1 => self.decode(base, reader, depth + 1, extensions),
                _ => Err(CodecError::value("invalid optional presence byte")),
            };
        }
        let array = if let Some(base) = kind.strip_suffix("[]") {
            Some((base, reader.count()?))
        } else {
            fixed_array(kind)?
        };
        if let Some((base, count)) = array {
            if count > MAX_ELEMENTS {
                return Err(CodecError::limits("array element limit"));
            }
            let mut values = Vec::with_capacity(count.min(1024));
            for _ in 0..count {
                values.push(self.decode(base, reader, depth + 1, false)?);
            }
            return Ok(Value::Array(values));
        }
        if scalar::is_builtin(kind, self.profile) {
            return scalar::decode(kind, reader, self.profile);
        }
        if kind.starts_with("protobuf::") {
            return self.protobuf.decode(kind, reader, depth);
        }
        if let Some(record) = self.enums.get(kind) {
            let value = scalar::decode(text(record, "type")?, reader, self.profile)?;
            let numeric = value
                .as_i64()
                .map(i128::from)
                .or_else(|| value.as_u64().map(i128::from))
                .or_else(|| value.as_str().and_then(|s| s.parse::<i128>().ok()));
            if let Some(numeric) = numeric {
                for member in records(record, "values")? {
                    if scalar::parse_signed(&member["value"], 64).map_err(CodecError::into_abi)?
                        == numeric
                    {
                        return Ok(Value::String(text(member, "name")?.into()));
                    }
                }
            }
            return Ok(value);
        }
        if let Some(record) = self.variants.get(kind) {
            let types = records(record, "types")?;
            let index = reader.varuint()? as usize;
            let selected = types
                .get(index)
                .and_then(Value::as_str)
                .ok_or_else(|| CodecError::value("variant selector out of range"))?;
            return Ok(Value::Array(vec![
                Value::String(selected.into()),
                self.decode(selected, reader, depth + 1, extensions)?,
            ]));
        }
        if self.structs.contains_key(kind) {
            let mut fields = Vec::new();
            self.fields(kind, &mut fields, 0)?;
            let mut value = Map::new();
            for (index, field) in fields.iter().enumerate() {
                let field_type = text(field, "type")?;
                if field_type.ends_with('$') && reader.remaining() == 0 && extensions {
                    continue;
                }
                let inner = field_type.strip_suffix('$').unwrap_or(field_type);
                value.insert(
                    text(field, "name")?.into(),
                    self.decode(
                        inner,
                        reader,
                        depth + 1,
                        extensions && index + 1 == fields.len(),
                    )?,
                );
            }
            return Ok(Value::Object(value));
        }
        Err(CodecError::unsupported(format!("unknown ABI type {kind}")))
    }

    fn encode(
        &self,
        kind: &str,
        value: &Value,
        writer: &mut Writer,
        depth: usize,
        extensions: bool,
    ) -> Result<(), CodecError> {
        writer.node()?;
        if depth > MAX_DEPTH {
            return Err(CodecError::limits("value recursion limit"));
        }
        let kind = self.resolve(kind)?;
        if let Some(base) = kind.strip_suffix('$') {
            return self.encode(base, value, writer, depth + 1, extensions);
        }
        if let Some(base) = kind.strip_suffix('?') {
            if value.is_null() {
                writer.byte(0)
            } else {
                writer.byte(1)?;
                self.encode(base, value, writer, depth + 1, extensions)
            }
        } else if let Some(base) = kind.strip_suffix("[]") {
            let values = array(value)?;
            writer.varuint(values.len() as u32)?;
            for value in values {
                self.encode(base, value, writer, depth + 1, false)?;
            }
            Ok(())
        } else if let Some((base, size)) = fixed_array(kind)? {
            let values = array(value)?;
            if values.len() != size {
                return Err(CodecError::value("incorrect fixed array size"));
            }
            for value in values {
                self.encode(base, value, writer, depth + 1, false)?;
            }
            Ok(())
        } else if scalar::is_builtin(kind, self.profile) {
            scalar::encode(kind, value, writer, self.profile)
        } else if kind.starts_with("protobuf::") {
            self.protobuf.encode(kind, value, writer, depth)
        } else if let Some(record) = self.enums.get(kind) {
            let mut numeric = value.clone();
            if let Some(name) = value.as_str() {
                let members = records(record, "values")?;
                let exact = members
                    .iter()
                    .find(|member| member["name"].as_str() == Some(name));
                let member = if let Some(exact) = exact {
                    Some(exact)
                } else {
                    let mut matches = members.iter().filter(|member| {
                        member["name"]
                            .as_str()
                            .and_then(|s| s.rsplit_once('_'))
                            .is_some_and(|(_, suffix)| suffix == name)
                    });
                    let first = matches.next();
                    if matches.next().is_some() {
                        return Err(CodecError::value("ambiguous enum suffix"));
                    }
                    first
                };
                if let Some(member) = member {
                    numeric = member["value"].clone();
                } else {
                    let underlying = text(record, "type")?;
                    let bits = underlying
                        .trim_start_matches('u')
                        .strip_prefix("int")
                        .and_then(|s| s.parse::<u32>().ok())
                        .unwrap_or(0);
                    if bits < 64 || name.parse::<i128>().is_err() && name.parse::<u128>().is_err() {
                        return Err(CodecError::value("unknown enum member"));
                    }
                }
            }
            scalar::encode(text(record, "type")?, &numeric, writer, self.profile)
        } else if let Some(record) = self.variants.get(kind) {
            let value = array(value)?;
            if value.len() != 2 {
                return Err(CodecError::value("variant needs [type,value]"));
            }
            let selected = string(&value[0])?;
            let types = records(record, "types")?;
            let index = types
                .iter()
                .position(|v| v.as_str() == Some(selected))
                .ok_or_else(|| CodecError::value("unknown variant arm"))?;
            writer.varuint(index as u32)?;
            self.encode(selected, &value[1], writer, depth + 1, extensions)
        } else if self.structs.contains_key(kind) {
            let mut fields = Vec::new();
            self.fields(kind, &mut fields, 0)?;
            let object = object(value)?;
            if object.keys().any(|key| {
                !fields
                    .iter()
                    .any(|field| field["name"].as_str() == Some(key))
            }) {
                return Err(CodecError::value("unknown struct field"));
            }
            let mut omitted = false;
            for (index, field) in fields.iter().enumerate() {
                let name = text(field, "name")?;
                let kind = text(field, "type")?;
                let item = object.get(name);
                if item.is_none() && kind.ends_with('$') && extensions {
                    omitted = true;
                    continue;
                }
                if omitted {
                    return Err(CodecError::value("field after omitted binary extension"));
                }
                let null = Value::Null;
                let item = match item {
                    Some(item) => item,
                    None if self.resolve(kind)?.ends_with('?') => &null,
                    None => return Err(CodecError::value(format!("missing struct field {name}"))),
                };
                self.encode(
                    kind.strip_suffix('$').unwrap_or(kind),
                    item,
                    writer,
                    depth + 1,
                    extensions && index + 1 == fields.len(),
                )?;
            }
            Ok(())
        } else {
            Err(CodecError::unsupported(format!("unknown ABI type {kind}")))
        }
    }
}

/// Decode one complete value. No bytes after the selected value are silently ignored.
pub fn decode_value(
    abi: &Value,
    type_name: &str,
    bytes: &[u8],
    profile: &CodecProfile,
) -> Result<Value, CodecError> {
    let schema = Schema::new(abi, profile)?;
    schema.validate_type(type_name, 0)?;
    let mut reader = Reader::new(bytes)?;
    let value = schema.decode(type_name, &mut reader, 0, true)?;
    reader.end()?;
    check_json(&value)?;
    Ok(value)
}

/// Encode one bounded value under the explicitly selected ABI and protocol profile.
pub fn encode_value(
    abi: &Value,
    type_name: &str,
    value: &Value,
    profile: &CodecProfile,
) -> Result<Vec<u8>, CodecError> {
    let schema = Schema::new(abi, profile)?;
    schema.validate_type(type_name, 0)?;
    check_json(value)?;
    let mut writer = Writer::new();
    schema.encode(type_name, value, &mut writer, 0, true)?;
    Ok(writer.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::MAX_NODES;
    use serde_json::json;

    #[test]
    fn zero_width_nested_fixed_arrays_consume_budget_before_allocating_outputs() {
        let profile = CodecProfile::default();
        let abi =
            json!({"version":"sysio::abi/1.3","structs":[{"name":"empty","base":"","fields":[]}]});
        let schema = Schema::new(&abi, &profile).unwrap();
        let mut reader = Reader::new(&[]).unwrap();
        reader.nodes = MAX_NODES - 2;
        assert_eq!(
            schema
                .decode("empty[2][2]", &mut reader, 0, true)
                .unwrap_err()
                .code(),
            "limits_exceeded"
        );
        assert_eq!(reader.nodes, MAX_NODES + 1);
        let mut writer = Writer::new();
        writer.nodes = MAX_NODES - 2;
        assert_eq!(
            schema
                .encode(
                    "empty[2][2]",
                    &json!([[{}, {}], [{}, {}]]),
                    &mut writer,
                    0,
                    true
                )
                .unwrap_err()
                .code(),
            "limits_exceeded"
        );
        assert!(writer.bytes.is_empty());
    }
}
