use super::binary::{Reader, Writer};
use super::{CodecError, MAX_DEPTH, MAX_ELEMENTS, MAX_NODES, check_json};
use prost::Message;
use prost_reflect::{
    DescriptorPool, DeserializeOptions, DynamicMessage, Kind, MessageDescriptor, ReflectMessage,
    SerializeOptions,
};
use serde_json::Value;
use std::collections::HashMap;

pub(crate) struct Protobuf {
    pool: Option<DescriptorPool>,
}
impl Protobuf {
    pub fn new(abi: &Value) -> Result<Self, CodecError> {
        let Some(raw) = abi.get("protobuf_types") else {
            return Ok(Self { pool: None });
        };
        let descriptor = match raw {
            Value::String(text) if text.is_empty() => return Ok(Self { pool: None }),
            Value::String(text) => serde_json::from_str(text)
                .map_err(|_| CodecError::abi("invalid protobuf descriptor JSON"))?,
            Value::Object(_) => raw.clone(),
            _ => {
                return Err(CodecError::abi(
                    "protobuf_types must be descriptor JSON or raw JSON text",
                ));
            }
        };
        check_json(&descriptor)?;
        let descriptor_type = DescriptorPool::global()
            .get_message_by_name("google.protobuf.FileDescriptorSet")
            .ok_or_else(|| CodecError::unsupported("descriptor schema unavailable"))?;
        let message = DynamicMessage::deserialize_with_options(
            descriptor_type,
            &descriptor,
            &DeserializeOptions::new().deny_unknown_fields(false),
        )
        .map_err(|e| CodecError::abi(format!("invalid FileDescriptorSet: {e}")))?;
        let pool = DescriptorPool::decode(message.encode_to_vec().as_slice())
            .map_err(|e| CodecError::abi(format!("invalid protobuf descriptors: {e}")))?;
        Ok(Self { pool: Some(pool) })
    }
    pub fn descriptor(&self, kind: &str) -> Result<MessageDescriptor, CodecError> {
        let name = kind
            .strip_prefix("protobuf::")
            .ok_or_else(|| CodecError::unsupported("invalid protobuf type prefix"))?;
        self.pool
            .as_ref()
            .and_then(|pool| pool.get_message_by_name(name))
            .ok_or_else(|| CodecError::unsupported(format!("unknown protobuf message {name}")))
    }
    pub fn decode(
        &self,
        kind: &str,
        reader: &mut Reader<'_>,
        depth: usize,
    ) -> Result<Value, CodecError> {
        let desc = self.descriptor(kind)?;
        let outer = reader.blob()?;
        let mut inner = Reader::new(outer)?;
        let payload = inner.blob()?;
        inner.end()?;
        let mut budget = MAX_NODES.saturating_sub(reader.nodes);
        preflight(&desc, payload, depth, &mut budget, &mut Tracker::default())?;
        reader.nodes = MAX_NODES - budget;
        let message = DynamicMessage::decode(desc, payload)
            .map_err(|e| CodecError::value(format!("invalid protobuf payload: {e}")))?;
        required(&message, depth)?;
        let value = message
            .serialize_with_options(
                serde_json::value::Serializer,
                &SerializeOptions::new().use_proto_field_name(true),
            )
            .map_err(|e| CodecError::value(format!("protobuf JSON: {e}")))?;
        check_json(&value)?;
        Ok(value)
    }
    pub fn encode(
        &self,
        kind: &str,
        value: &Value,
        writer: &mut Writer,
        depth: usize,
    ) -> Result<(), CodecError> {
        check_json(value)?;
        let desc = self.descriptor(kind)?;
        let message = DynamicMessage::deserialize_with_options(
            desc,
            value,
            &DeserializeOptions::new().deny_unknown_fields(false),
        )
        .map_err(|e| CodecError::value(format!("invalid protobuf JSON: {e}")))?;
        required(&message, depth)?;
        let payload = message.encode_to_vec();
        let mut budget = MAX_NODES.saturating_sub(writer.nodes);
        preflight(
            &message.descriptor(),
            &payload,
            depth,
            &mut budget,
            &mut Tracker::default(),
        )?;
        writer.nodes = MAX_NODES - budget;
        let mut inner = Writer::new();
        inner.blob(&payload)?;
        writer.blob(&inner.bytes)
    }
}

fn consume(budget: &mut usize) -> Result<(), CodecError> {
    *budget = budget
        .checked_sub(1)
        .ok_or_else(|| CodecError::limits("protobuf element limit"))?;
    Ok(())
}
fn varint(reader: &mut Reader<'_>) -> Result<u64, CodecError> {
    let mut value = 0;
    for i in 0..10 {
        let byte = reader.byte()?;
        if i == 9 && byte > 1 {
            return Err(CodecError::value("protobuf varint overflow"));
        }
        value |= u64::from(byte & 127) << (7 * i);
        if byte < 128 {
            return Ok(value);
        }
    }
    Err(CodecError::value("protobuf varint overflow"))
}

// Bound repeated packed fields and nested messages before prost allocates their
// dynamic representations. Unknown fields remain skippable, as in the node.
#[derive(Default)]
struct Tracker {
    counts: HashMap<u32, usize>,
    singular: HashMap<u32, Tracker>,
    unknown: usize,
    any_url: Option<String>,
    any_value: Option<Vec<u8>>,
}
impl Tracker {
    fn item(&mut self, number: u32) -> Result<(), CodecError> {
        let count = self.counts.entry(number).or_default();
        *count += 1;
        if *count > MAX_ELEMENTS {
            return Err(CodecError::limits("protobuf repeated/map field limit"));
        }
        Ok(())
    }
}

fn preflight(
    desc: &MessageDescriptor,
    bytes: &[u8],
    depth: usize,
    budget: &mut usize,
    tracker: &mut Tracker,
) -> Result<(), CodecError> {
    if depth > MAX_DEPTH {
        return Err(CodecError::limits("protobuf recursion limit"));
    }
    let mut reader = Reader::new(bytes)?;
    let any = desc.full_name() == "google.protobuf.Any";
    while reader.remaining() != 0 {
        consume(budget)?;
        let key = varint(&mut reader)?;
        let number = u32::try_from(key >> 3)
            .ok()
            .filter(|n| *n > 0 && *n < (1 << 29))
            .ok_or_else(|| CodecError::value("invalid protobuf field number"))?;
        let wire = key & 7;
        let field = desc.get_field(number);
        if let Some(field) = &field {
            let packed = wire == 2
                && field.is_list()
                && !matches!(field.kind(), Kind::String | Kind::Bytes | Kind::Message(_));
            let expected = match field.kind() {
                Kind::Double | Kind::Fixed64 | Kind::Sfixed64 => 1,
                Kind::Float | Kind::Fixed32 | Kind::Sfixed32 => 5,
                Kind::String | Kind::Bytes | Kind::Message(_) => 2,
                _ => 0,
            };
            if wire != expected && !packed {
                return Err(CodecError::value("protobuf wire type mismatch"));
            }
            if (field.is_list() || field.is_map()) && !packed {
                tracker.item(number)?;
            }
        } else {
            tracker.unknown += 1;
            if tracker.unknown > MAX_ELEMENTS {
                return Err(CodecError::limits("protobuf unknown field limit"));
            }
        }
        match wire {
            0 => {
                varint(&mut reader)?;
            }
            1 => {
                reader.read(8)?;
            }
            2 => {
                let size = usize::try_from(varint(&mut reader)?)
                    .map_err(|_| CodecError::value("protobuf size overflow"))?;
                let data = reader.read(size)?;
                if any && number == 1 {
                    tracker.any_url = Some(
                        std::str::from_utf8(data)
                            .map_err(|_| CodecError::value("invalid Any type_url UTF-8"))?
                            .to_owned(),
                    );
                }
                if any && number == 2 {
                    tracker.any_value = Some(data.to_vec());
                }
                if let Some(field) = field {
                    if let Kind::Message(nested) = field.kind() {
                        if field.is_list() || field.is_map() {
                            preflight(&nested, data, depth + 1, budget, &mut Tracker::default())?;
                        } else {
                            preflight(
                                &nested,
                                data,
                                depth + 1,
                                budget,
                                tracker.singular.entry(number).or_default(),
                            )?;
                        }
                    } else if field.is_list()
                        && !matches!(field.kind(), Kind::String | Kind::Bytes | Kind::Message(_))
                    {
                        let mut packed = Reader::new(data)?;
                        while packed.remaining() != 0 {
                            consume(budget)?;
                            tracker.item(number)?;
                            match field.kind() {
                                Kind::Double | Kind::Fixed64 | Kind::Sfixed64 => {
                                    packed.read(8)?;
                                }
                                Kind::Float | Kind::Fixed32 | Kind::Sfixed32 => {
                                    packed.read(4)?;
                                }
                                _ => {
                                    varint(&mut packed)?;
                                }
                            }
                        }
                    }
                }
            }
            5 => {
                reader.read(4)?;
            }
            3 | 4 => return Err(CodecError::unsupported("protobuf groups are unsupported")),
            _ => return Err(CodecError::value("invalid protobuf wire type")),
        }
    }
    // Any.value is opaque to the ordinary wire parser but expands into a
    // descriptor-resolved object during Google JSON rendering. Bound that
    // traversal before the dynamic serializer constructs the expanded object.
    if let Some(url) = &tracker.any_url
        && !url.is_empty()
        && let Some(value) = &tracker.any_value
    {
        let name = url.rsplit('/').next().unwrap_or(url);
        let nested = desc
            .parent_pool()
            .get_message_by_name(name)
            .ok_or_else(|| CodecError::value("unknown Any message type"))?;
        preflight(&nested, value, depth + 1, budget, &mut Tracker::default())?;
    }
    Ok(())
}

fn required(message: &DynamicMessage, depth: usize) -> Result<(), CodecError> {
    if depth > MAX_DEPTH {
        return Err(CodecError::limits("protobuf recursion limit"));
    }
    for field in message.descriptor().fields() {
        if field.cardinality() == prost_reflect::Cardinality::Required && !message.has_field(&field)
        {
            return Err(CodecError::value("missing required protobuf field"));
        }
    }
    for (_, value) in message.fields() {
        required_value(value, depth + 1)?;
    }
    Ok(())
}
fn required_value(value: &prost_reflect::Value, depth: usize) -> Result<(), CodecError> {
    if depth > MAX_DEPTH {
        return Err(CodecError::limits("protobuf recursion limit"));
    }
    match value {
        prost_reflect::Value::Message(message) => required(message, depth),
        prost_reflect::Value::List(values) => {
            for value in values {
                required_value(value, depth)?;
            }
            Ok(())
        }
        prost_reflect::Value::Map(values) => {
            for value in values.values() {
                required_value(value, depth)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn split_any_association_is_retained_before_any_dynamic_parser_runs() {
        let abi = json!({"protobuf_types":{"file":[{"name":"google/protobuf/any.proto","package":"google.protobuf","syntax":"proto3","messageType":[{"name":"Any","field":[{"name":"type_url","number":1,"label":"LABEL_OPTIONAL","type":"TYPE_STRING"},{"name":"value","number":2,"label":"LABEL_OPTIONAL","type":"TYPE_BYTES"}]}]},{"name":"inner.proto","package":"test","syntax":"proto3","messageType":[{"name":"Inner","field":[{"name":"values","number":1,"label":"LABEL_REPEATED","type":"TYPE_UINT32"}]}]}]}});
        let protobuf = Protobuf::new(&abi).unwrap();
        let descriptor = protobuf
            .descriptor("protobuf::google.protobuf.Any")
            .unwrap();
        let mut tracker = Tracker::default();
        let mut budget = MAX_NODES;
        let mut url = Writer::new();
        url.byte(10).unwrap();
        url.string("type.googleapis.com/test.Inner").unwrap();
        preflight(&descriptor, &url.bytes, 1, &mut budget, &mut tracker).unwrap();
        assert_eq!(
            tracker.any_url.as_deref(),
            Some("type.googleapis.com/test.Inner")
        );
        let mut packed = Writer::new();
        packed.byte(10).unwrap();
        packed.blob(&vec![0; MAX_ELEMENTS + 1]).unwrap();
        let mut value = Writer::new();
        value.byte(18).unwrap();
        value.blob(&packed.bytes).unwrap();
        let error = preflight(&descriptor, &value.bytes, 1, &mut budget, &mut tracker).unwrap_err();
        assert_eq!(error.code(), "limits_exceeded");
    }
}
