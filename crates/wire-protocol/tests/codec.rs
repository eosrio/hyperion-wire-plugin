use hyperion_wire_protocol::codec::{
    CodecProfile, MAX_BYTES, MAX_ELEMENTS, decode_abi, decode_value, encode_abi, encode_value,
};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/codec")
}
fn unhex(text: &str) -> Vec<u8> {
    text.as_bytes()
        .chunks_exact(2)
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect()
}
fn empty_abi() -> Value {
    json!({"version":"sysio::abi/1.3","types":[],"structs":[],"actions":[],"tables":[],"variants":[],"enums":[]})
}

#[test]
fn captured_ship_handshake_request_schema_is_usable() {
    let abi: Value =
        serde_json::from_str(&fs::read_to_string(corpus().join("ship.abi.json")).unwrap()).unwrap();
    let value = decode_value(
        &abi,
        "request",
        &[0],
        &CodecProfile::for_id("wire-sysio-7dede884-engineering-v1").unwrap(),
    )
    .unwrap();
    assert_eq!(value, json!(["get_status_request_v0", {}]));
}

// Normalize only the explicitly declared portable wide-integer representation.
// All byte/layout expectations remain independent official clio output.
#[test]
fn official_oracle_decode_values_and_complete_meta_abis() {
    let vectors: Value =
        serde_json::from_str(&fs::read_to_string(corpus().join("oracle-vectors.json")).unwrap())
            .unwrap();
    let mut failures = vec![];
    for vector in vectors["vectors"].as_array().unwrap() {
        let profile = CodecProfile::for_id(vector["profileId"].as_str().unwrap()).unwrap();
        let bytes = unhex(vector["hex"].as_str().unwrap());
        let expected = &vector["expected"];
        let result = if vector["operation"] == "decodeAbi" {
            decode_abi(&bytes, &profile)
        } else {
            let abi = vector["abiPath"]
                .as_str()
                .map(|p| {
                    serde_json::from_str(&fs::read_to_string(corpus().join(p)).unwrap()).unwrap()
                })
                .unwrap_or_else(empty_abi);
            decode_value(&abi, vector["typeName"].as_str().unwrap(), &bytes, &profile)
        };
        match result {
            Ok(mut value) => {
                // Canonical metadata keeps descriptor JSON text, including its
                // exact spelling; node JSON displays a parsed object instead.
                let mut expected = expected.clone();
                if vector["operation"] == "decodeAbi" {
                    if value.get("protobuf_types").is_some_and(Value::is_string) {
                        let raw = value["protobuf_types"].as_str().unwrap();
                        if raw.is_empty() {
                            value.as_object_mut().unwrap().remove("protobuf_types");
                        } else {
                            value["protobuf_types"] = serde_json::from_str(raw).unwrap();
                        }
                    }
                    normalize_metadata_ints(&mut expected);
                }
                // Official clio renders safe wide integers as numbers. Use
                // the independent type-bearing expected input to convert only
                // number/string equivalence here; exact fixture tests below
                // separately assert every canonical integer category.
                if !portable_equal(&value, &expected) {
                    failures.push(format!(
                        "{}: decoded {value} expected {expected}",
                        vector["id"]
                    ));
                }
            }
            Err(error) => failures.push(format!("{}: {error}", vector["id"])),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
fn normalize_metadata_ints(value: &mut Value) {
    for key in ["error_messages", "enums"] {
        if let Some(items) = value.get_mut(key).and_then(Value::as_array_mut) {
            for item in items {
                if key == "error_messages" {
                    if let Some(v) = item.get_mut("error_code") {
                        if v.is_number() {
                            *v = Value::String(v.to_string());
                        }
                    }
                } else if let Some(members) = item.get_mut("values").and_then(Value::as_array_mut) {
                    for m in members {
                        if m["value"].is_number() {
                            m["value"] = Value::String(m["value"].to_string());
                        }
                    }
                }
            }
        }
    }
}
fn portable_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::String(a), Value::Number(b)) => a == &b.to_string(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| portable_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, v)| b.get(k).is_some_and(|other| portable_equal(v, other)))
        }
        _ => a == b,
    }
}

#[test]
fn all_metadata_sections_and_every_truncation_boundary() {
    let profile = CodecProfile::default();
    let abi = json!({"version":"sysio::abi/1.3","types":[],"structs":[],"actions":[],"tables":[{"name":"free-table-name","index_type":"i64","key_names":["id"],"key_types":["uint64"],"type":"uint64","table_id":0,"secondary_indexes":[{"name":"secondary","key_type":"uint64","table_id":65535}]}],"ricardian_clauses":[],"error_messages":[{"error_code":"18446744073709551615","error_msg":"message"}],"abi_extensions":[[7,"ff00"]],"variants":[{"name":"v","types":["uint64"]}],"action_results":[{"name":"run","result_type":"uint64"}],"enums":[{"name":"e","type":"int64","values":[{"name":"NEG","value":"-1"}]}],"protobuf_types":"{ \"file\": [] }"});
    let bytes = encode_abi(&abi, &profile).unwrap();
    assert_eq!(decode_abi(&bytes, &profile).unwrap(), abi);
    assert_eq!(
        encode_abi(&decode_abi(&bytes, &profile).unwrap(), &profile).unwrap(),
        bytes
    );
    // Required fields never accept truncation. Optional complete field boundaries
    // are valid older layouts, and every accepted prefix must round-trip exactly.
    for end in 0..bytes.len() {
        if let Ok(decoded) = decode_abi(&bytes[..end], &profile) {
            assert_eq!(encode_abi(&decoded, &profile).unwrap(), bytes[..end]);
        }
    }
    let mut extra = bytes.clone();
    extra.push(0);
    assert_eq!(
        decode_abi(&extra, &profile).unwrap_err().code(),
        "unsupported_feature"
    );
    assert_eq!(
        decode_abi(&vec![0; MAX_BYTES + 1], &profile)
            .unwrap_err()
            .code(),
        "limits_exceeded"
    );
}

#[test]
fn nested_enums_timestamps_optionals_fixed_arrays_variants_and_extensions() {
    let profile = CodecProfile::default();
    let abi = json!({"version":"sysio::abi/1.3","types":[{"new_type_name":"clock","type":"block_timestamp_type"}],"structs":[{"name":"base","base":"","fields":[{"name":"clock","type":"clock"}]},{"name":"row","base":"base","fields":[{"name":"items","type":"uint64[2]"},{"name":"state","type":"state"},{"name":"opt","type":"uint8?"},{"name":"choice","type":"choice"},{"name":"tail","type":"string$"}]}],"variants":[{"name":"choice","types":["uint8","string"]}],"enums":[{"name":"state","type":"int8","values":[{"name":"STATE_READY","value":1},{"name":"STATE_FAILED","value":-1}]}]});
    let value = json!({"clock":"2025-01-01T00:00:00.500","items":["0","18446744073709551615"],"state":"STATE_READY","opt":null,"choice":["string","yes"]});
    let bytes = encode_value(&abi, "row", &value, &profile).unwrap();
    assert_eq!(decode_value(&abi, "row", &bytes, &profile).unwrap(), value);
    assert_eq!(
        encode_value(&abi, "state", &json!("READY"), &profile).unwrap(),
        vec![1]
    );
    assert_eq!(
        decode_value(&abi, "state", &[127], &profile).unwrap(),
        json!(127)
    );
    assert_eq!(
        decode_value(&abi, "uint64", &u64::MAX.to_le_bytes(), &profile).unwrap(),
        json!("18446744073709551615")
    );
    assert!(decode_value(&abi, "uint8?", &[2, 0], &profile).is_err());
    assert!(decode_value(&abi, "row", &bytes[..bytes.len() - 1], &profile).is_err());
    let mut extra = bytes;
    extra.push(0xff);
    assert!(decode_value(&abi, "row", &extra, &profile).is_err());
}

#[test]
fn profiles_prevent_silent_slug_reinterpretation_and_keep_raw_noncanonical_rendering() {
    let modern = CodecProfile::default();
    let release = CodecProfile::for_id("wire-sysio-7dede884-engineering-v1").unwrap();
    let abi = json!({"version":"sysio::abi/1.3","structs":[{"name":"slug_name","base":"","fields":[{"name":"value","type":"uint64"}]}]});
    assert_eq!(
        decode_value(&abi, "slug_name", &1u64.to_le_bytes(), &release).unwrap(),
        json!({"value":"1"})
    );
    assert_eq!(
        decode_value(&abi, "slug_name", &1u64.to_le_bytes(), &modern).unwrap(),
        json!("")
    );
    assert_eq!(
        decode_value(&empty_abi(), "slug_name", &1u64.to_le_bytes(), &release)
            .unwrap_err()
            .code(),
        "unsupported_feature"
    );
    let raw = (1u64 << 63) | (5u64 << 42) | (20u64 << 36) | (8u64 << 30);
    assert_eq!(
        decode_value(&empty_abi(), "slug_name", &raw.to_le_bytes(), &modern).unwrap(),
        json!("ETH")
    );
    assert_eq!(
        decode_value(
            &empty_abi(),
            "slug_name",
            &(63u64 << 42).to_le_bytes(),
            &modern
        )
        .unwrap(),
        json!("\u{0000}")
    );
    for bad in [json!(7), json!("7ETH"), json!("eth"), json!("ABCDEFGHI")] {
        assert!(encode_value(&empty_abi(), "slug_name", &bad, &modern).is_err());
    }
}

#[test]
fn recursion_arrays_varints_unsafe_numbers_and_cyclic_schemas_are_bounded() {
    let profile = CodecProfile::default();
    let abi = empty_abi();
    for bytes in [
        vec![0x80, 0],
        vec![0xff, 0xff, 0xff, 0xff, 0x10],
        vec![0x80; 6],
    ] {
        assert!(decode_value(&abi, "varuint32", &bytes, &profile).is_err());
    }
    assert_eq!(
        decode_value(&abi, "uint8[]", &[0xff, 0xff, 0xff, 0xff, 15], &profile)
            .unwrap_err()
            .code(),
        "limits_exceeded"
    );
    assert_eq!(
        decode_value(&abi, &format!("uint8[{}]", MAX_ELEMENTS + 1), &[], &profile)
            .unwrap_err()
            .code(),
        "limits_exceeded"
    );
    assert!(encode_value(&abi, "uint64", &json!(9_007_199_254_740_992u64), &profile).is_err());
    let cyclic = json!({"version":"sysio::abi/1.3","types":[{"new_type_name":"a","type":"b"},{"new_type_name":"b","type":"a"}]});
    assert_eq!(
        decode_value(&cyclic, "a", &[], &profile)
            .unwrap_err()
            .code(),
        "invalid_abi"
    );
    let recursive = json!({"version":"sysio::abi/1.3","structs":[{"name":"r","base":"","fields":[{"name":"next","type":"r?"}]}]});
    assert_eq!(
        decode_value(&recursive, "r", &[1; 100], &profile)
            .unwrap_err()
            .code(),
        "limits_exceeded"
    );
}

#[test]
fn protobuf_two_prefixes_names_unknown_enums_and_required_fields() {
    let profile = CodecProfile::default();
    let abi: Value = serde_json::from_str(
        &fs::read_to_string(corpus().join("artifacts/6508c9e8/proto_abi_test.abi")).unwrap(),
    )
    .unwrap();
    let value = json!({"str_value":"hello","value":-3});
    let bytes = encode_value(&abi, "protobuf::test.ActResult", &value, &profile).unwrap();
    assert_eq!(
        decode_value(&abi, "protobuf::test.ActResult", &bytes, &profile).unwrap(),
        value
    );
    for end in 0..bytes.len() {
        assert!(decode_value(&abi, "protobuf::test.ActResult", &bytes[..end], &profile).is_err());
    }
    let mut bad = bytes.clone();
    bad[0] -= 1;
    assert!(decode_value(&abi, "protobuf::test.ActResult", &bad, &profile).is_err());
    let mut bad = bytes.clone();
    bad[1] -= 1;
    assert!(decode_value(&abi, "protobuf::test.ActResult", &bad, &profile).is_err());
    let mut bad = bytes;
    bad[1] += 1;
    assert!(decode_value(&abi, "protobuf::test.ActResult", &bad, &profile).is_err());
}

#[test]
fn all_crypto_tags_are_transport_framed_with_checksums_and_bounded_lengths() {
    let profile = CodecProfile::default();
    let abi = empty_abi();
    let keys = [
        ("public_key", [vec![0], vec![2], vec![1; 32]].concat()),
        ("signature", [vec![0], vec![31], vec![1; 64]].concat()),
        ("public_key", [vec![1], vec![3], vec![2; 32]].concat()),
        ("signature", [vec![1], vec![32], vec![2; 64]].concat()),
        (
            "public_key",
            [
                vec![2],
                vec![2],
                vec![3; 32],
                vec![1, 7],
                b"example".to_vec(),
            ]
            .concat(),
        ),
        (
            "signature",
            [
                vec![2],
                vec![31],
                vec![3; 64],
                vec![2, 1, 2, 2],
                b"{}".to_vec(),
            ]
            .concat(),
        ),
        // EM public material is the independently known secp256k1 generator;
        // compression/decompression is validated, no signature/authentication claim.
        (
            "public_key",
            [
                vec![3],
                unhex("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
            ]
            .concat(),
        ),
        ("signature", [vec![3], vec![4; 65]].concat()),
        ("public_key", [vec![4], vec![5; 32]].concat()),
        ("signature", [vec![4], vec![6; 96]].concat()),
        ("public_key", [vec![5, 1], vec![7; 96]].concat()),
        ("signature", [vec![5, 1], vec![8; 192]].concat()),
    ];
    for (kind, bytes) in keys {
        let decoded = decode_value(&abi, kind, &bytes, &profile).unwrap();
        assert_eq!(
            encode_value(&abi, kind, &decoded, &profile).unwrap(),
            bytes,
            "{kind}: {decoded}"
        );
        for end in 0..bytes.len() {
            assert!(decode_value(&abi, kind, &bytes[..end], &profile).is_err());
        }
        let mut extra = bytes;
        extra.push(0);
        assert!(decode_value(&abi, kind, &extra, &profile).is_err());
        if decoded.as_str().unwrap().starts_with("PUB_K1_") {
            let mut tampered = decoded.as_str().unwrap().to_owned();
            let last = tampered.pop().unwrap();
            tampered.push(if last == '1' { '2' } else { '1' });
            assert!(encode_value(&abi, kind, &json!(tampered), &profile).is_err());
        }
    }
    assert_eq!(
        decode_value(&abi, "signature", &[6], &profile)
            .unwrap_err()
            .code(),
        "unsupported_feature"
    );
    assert!(decode_value(&abi, "public_key", &[5, 95], &profile).is_err());
    assert!(decode_value(&abi, "public_key", &[5, 0], &profile).is_err());
    assert!(decode_value(&abi, "signature", &[5, 2], &profile).is_err());
    assert!(decode_value(&abi, "public_key", &[3, 4, 0, 0, 0], &profile).is_err());
}

#[test]
fn protobuf_preserves_field_names_wide_values_enums_and_required_semantics() {
    let descriptor = json!({"file":[{"name":"bounded.proto","package":"test","syntax":"proto3","enumType":[{"name":"Mode","value":[{"name":"MODE_UNKNOWN","number":0},{"name":"MODE_READY","number":1}]}],"messageType":[{"name":"Record","field":[{"name":"snake_case","number":1,"label":"LABEL_OPTIONAL","type":"TYPE_STRING"},{"name":"wide_count","number":2,"label":"LABEL_OPTIONAL","type":"TYPE_UINT64"},{"name":"mode","number":3,"label":"LABEL_OPTIONAL","type":"TYPE_ENUM","typeName":".test.Mode"},{"name":"values","number":4,"label":"LABEL_REPEATED","type":"TYPE_INT64"}]}]}]});
    let abi = json!({"version":"sysio::abi/1.3","protobuf_types":descriptor});
    let profile = CodecProfile::default();
    let expected = json!({"snake_case":"kept","wide_count":"18446744073709551615","mode":99,"values":["1","-9223372036854775808"]});
    let bytes = encode_value(&abi, "protobuf::test.Record", &expected, &profile).unwrap();
    assert_eq!(
        decode_value(&abi, "protobuf::test.Record", &bytes, &profile).unwrap(),
        expected
    );
    let alias = json!({"snakeCase":"kept","wideCount":"18446744073709551615","mode":99,"values":["1","-9223372036854775808"],"unknown":"ignored like node"});
    assert_eq!(
        encode_value(&abi, "protobuf::test.Record", &alias, &profile).unwrap(),
        bytes
    );
    let required_abi = json!({"version":"sysio::abi/1.3","protobuf_types":{"file":[{"name":"required.proto","package":"test","syntax":"proto2","messageType":[{"name":"Required","field":[{"name":"must","number":1,"label":"LABEL_REQUIRED","type":"TYPE_INT32"}]}]}]}});
    assert!(decode_value(&required_abi, "protobuf::test.Required", &[1, 0], &profile).is_err());
    assert!(
        encode_value(
            &required_abi,
            "protobuf::test.Required",
            &json!({}),
            &profile
        )
        .is_err()
    );
}

#[test]
fn protobuf_merged_singular_messages_cannot_bypass_repeated_allocation_bounds() {
    let abi = json!({"version":"sysio::abi/1.3","protobuf_types":{"file":[{"name":"merged.proto","package":"test","syntax":"proto3","messageType":[{"name":"Child","field":[{"name":"values","number":1,"label":"LABEL_REPEATED","type":"TYPE_UINT32"}]},{"name":"Parent","field":[{"name":"child","number":1,"label":"LABEL_OPTIONAL","type":"TYPE_MESSAGE","typeName":".test.Child"}]}]}]}});
    fn varuint(mut v: usize, out: &mut Vec<u8>) {
        loop {
            let byte = (v & 127) as u8;
            v >>= 7;
            out.push(byte | if v != 0 { 128 } else { 0 });
            if v == 0 {
                break;
            }
        }
    }
    let mut child = vec![10];
    varuint(50_001, &mut child);
    child.resize(child.len() + 50_001, 0);
    let mut payload = vec![];
    for _ in 0..2 {
        payload.push(10);
        varuint(child.len(), &mut payload);
        payload.extend_from_slice(&child);
    }
    let mut inner = vec![];
    varuint(payload.len(), &mut inner);
    inner.extend(payload);
    let mut bytes = vec![];
    varuint(inner.len(), &mut bytes);
    bytes.extend(inner);
    assert_eq!(
        decode_value(
            &abi,
            "protobuf::test.Parent",
            &bytes,
            &CodecProfile::default()
        )
        .unwrap_err()
        .code(),
        "limits_exceeded"
    );
}

#[test]
fn any_embedded_payloads_are_bounded_before_google_json_expansion() {
    let mut abi = json!({"version":"sysio::abi/1.3","protobuf_types":{"file":[{"name":"google/protobuf/any.proto","package":"google.protobuf","syntax":"proto3","messageType":[{"name":"Any","field":[{"name":"type_url","number":1,"label":"LABEL_OPTIONAL","type":"TYPE_STRING"},{"name":"value","number":2,"label":"LABEL_OPTIONAL","type":"TYPE_BYTES"}]}]},{"name":"inner.proto","package":"test","syntax":"proto3","messageType":[{"name":"Inner","field":[{"name":"values","number":1,"label":"LABEL_REPEATED","type":"TYPE_UINT32"}]}]}]}});
    fn varuint(mut v: usize, out: &mut Vec<u8>) {
        loop {
            let byte = (v & 127) as u8;
            v >>= 7;
            out.push(byte | if v != 0 { 128 } else { 0 });
            if v == 0 {
                break;
            }
        }
    }
    let mut inner = vec![10];
    varuint(MAX_ELEMENTS + 1, &mut inner);
    inner.resize(inner.len() + MAX_ELEMENTS + 1, 0);
    let url = b"type.googleapis.com/test.Inner";
    let mut payload = vec![10];
    varuint(url.len(), &mut payload);
    payload.extend_from_slice(url);
    payload.push(18);
    varuint(inner.len(), &mut payload);
    payload.extend_from_slice(&inner);
    let mut framed = vec![];
    varuint(payload.len(), &mut framed);
    framed.extend(payload);
    let mut bytes = vec![];
    varuint(framed.len(), &mut bytes);
    bytes.extend(framed);
    assert_eq!(
        decode_value(
            &abi,
            "protobuf::google.protobuf.Any",
            &bytes,
            &CodecProfile::default()
        )
        .unwrap_err()
        .code(),
        "limits_exceeded"
    );
    // A singular Any message can be merged from separate wire occurrences.
    // The URL in one segment still governs the opaque value in the next.
    abi["protobuf_types"]["file"][1]["dependency"] = json!(["google/protobuf/any.proto"]);
    abi["protobuf_types"]["file"][1]["messageType"].as_array_mut().unwrap().push(json!({"name":"Parent","field":[{"name":"any","number":1,"label":"LABEL_OPTIONAL","type":"TYPE_MESSAGE","typeName":".google.protobuf.Any"}]}));
    let mut first = vec![10];
    varuint(url.len(), &mut first);
    first.extend_from_slice(url);
    let mut second = vec![18];
    varuint(inner.len(), &mut second);
    second.extend(inner);
    let mut payload = vec![];
    for segment in [first, second] {
        payload.push(10);
        varuint(segment.len(), &mut payload);
        payload.extend(segment);
    }
    let mut inner = vec![];
    varuint(payload.len(), &mut inner);
    inner.extend(payload);
    let mut bytes = vec![];
    varuint(inner.len(), &mut bytes);
    bytes.extend(inner);
    assert_eq!(
        decode_value(
            &abi,
            "protobuf::test.Parent",
            &bytes,
            &CodecProfile::default()
        )
        .unwrap_err()
        .code(),
        "limits_exceeded"
    );
}

#[test]
fn crypto_work_is_bounded_before_base58_and_variable_frame_processing() {
    let abi = empty_abi();
    let profile = CodecProfile::default();
    assert_eq!(
        encode_value(
            &abi,
            "public_key",
            &json!(format!("PUB_K1_{}", "1".repeat(8194))),
            &profile
        )
        .unwrap_err()
        .code(),
        "limits_exceeded"
    );
    // Declared variable lengths are rejected before attempting to consume or
    // UTF-8 decode their payload, so this probe needs no oversized allocation.
    let mut key = [vec![2], vec![0; 33], vec![255], vec![0x81, 0x20]].concat();
    assert_eq!(
        decode_value(&abi, "public_key", &key, &profile)
            .unwrap_err()
            .code(),
        "limits_exceeded"
    );
    key.truncate(35);
    key.extend_from_slice(&[1, b'x']);
    let value = decode_value(&abi, "public_key", &key, &profile).unwrap();
    assert_eq!(
        encode_value(&abi, "public_key", &value, &profile).unwrap(),
        key
    );
}

#[test]
fn negative_time_points_render_node_duration_and_write_precision_is_explicit() {
    let profile = CodecProfile::default();
    let abi = empty_abi();
    for (raw, text) in [
        (-1i64, "-000000.000001"),
        (-1_000_000, "-000001"),
        (-3_600_000_000, "-010000"),
    ] {
        assert_eq!(
            decode_value(&abi, "time_point", &raw.to_le_bytes(), &profile).unwrap(),
            json!(text)
        );
    }
    assert_eq!(
        encode_value(
            &abi,
            "time_point",
            &json!("2025-01-01T00:00:00.123456"),
            &profile
        )
        .unwrap_err()
        .code(),
        "invalid_value"
    );
    assert_eq!(
        decode_value(&abi, "float32", &f32::INFINITY.to_le_bytes(), &profile).unwrap(),
        json!("inf")
    );
    assert_eq!(
        decode_value(&abi, "float64", &f64::NAN.to_le_bytes(), &profile).unwrap(),
        json!("nan")
    );
}
