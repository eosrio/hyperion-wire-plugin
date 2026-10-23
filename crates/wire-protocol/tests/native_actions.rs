//! Original-source regressions plus explicitly constructed, noncanonical-source controls.
use flate2::{Compression, write::ZlibEncoder};
use hyperion_wire_protocol::codec::native_actions::{
    ONBLOCK_KIND, decode_native_value, encode_native_value, observe_native_actions,
};
use hyperion_wire_protocol::codec::{CodecProfile, decode_abi, decode_value, encode_value};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/codec")
}
fn fixture_root() -> PathBuf {
    root().join("native-onblock-6508-20261022")
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn unhex(text: &str) -> Vec<u8> {
    text.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
fn hash(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
fn schema_json() -> String {
    fs::read_to_string(root().join("native-genesis-6508-20261020/ship.abi.json")).unwrap()
}
fn schema() -> Value {
    serde_json::from_str(&schema_json()).unwrap()
}
fn profile() -> CodecProfile {
    CodecProfile::default()
}

struct Fixture {
    input: Value,
    source: Value,
    expected: Value,
    block: Value,
    traces: Value,
}
fn fixture(number: u64) -> Fixture {
    let abi = schema();
    let profile = profile();
    let expected: Vec<Value> =
        serde_json::from_slice(&fs::read(fixture_root().join("expected.json")).unwrap()).unwrap();
    let expected = expected
        .into_iter()
        .find(|case| case["blockNum"] == number)
        .unwrap();
    let frame = fs::read(fixture_root().join(format!("block-{number:06}.bin"))).unwrap();
    let result = decode_value(&abi, "result", &frame, &profile).unwrap();
    let envelope = &result[1];
    let input = json!({"schemaJson":schema_json(),"blockHex":envelope["block"],"tracesHex":envelope["traces"]});
    let source = json!({"chainId":"9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d",
        "blockNum":number,"blockId":expected["blockId"],"previousBlockId":envelope["prev_block"]["block_id"]});
    let block = decode_value(
        &abi,
        "signed_block",
        &unhex(input["blockHex"].as_str().unwrap()),
        &profile,
    )
    .unwrap();
    let traces = decode_value(
        &abi,
        "transaction_trace[]",
        &unhex(input["tracesHex"].as_str().unwrap()),
        &profile,
    )
    .unwrap();
    Fixture {
        input,
        source,
        expected,
        block,
        traces,
    }
}
fn constructed(fixture: &mut Fixture) {
    fixture.input["blockHex"] = json!(hex(&encode_value(
        &schema(),
        "signed_block",
        &fixture.block,
        &profile()
    )
    .unwrap()));
    fixture.input["tracesHex"] = json!(hex(&encode_value(
        &schema(),
        "transaction_trace[]",
        &fixture.traces,
        &profile()
    )
    .unwrap()));
}
fn incomplete(fixture: &Fixture, code: &str) -> Value {
    let result = observe_native_actions(&fixture.input, &fixture.source, &profile()).unwrap();
    assert_eq!(result["decisions"][0]["kind"], "incomplete");
    assert_eq!(result["decisions"][0]["error"]["code"], code);
    assert!(
        !result["decisions"][0]
            .as_object()
            .unwrap()
            .contains_key("nativeKind")
    );
    result
}
fn unsigned(action: &Value, expiration: &str) -> Value {
    json!({"expiration":expiration,"ref_block_num":0,"ref_block_prefix":0,"max_net_usage_words":0,
        "max_cpu_usage_ms":0,"delay_sec":0,"context_free_actions":[],"actions":[action.clone()],"transaction_extensions":[]})
}
fn packed(bytes: &[u8], compression: u8) -> Value {
    json!({"cpu_usage_us":[0],"trx":{"signatures":[],"compression":compression,
        "packed_context_free_data":"","packed_trx":hex(bytes)}})
}
fn compress(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}
fn add_user(fixture: &mut Fixture) -> Vec<u8> {
    let mut user = fixture.traces[0].clone();
    let action = &mut user[1]["action_traces"][0][1];
    action["receipt"][1]["global_sequence"] = json!(
        (fixture.expected["globalSequence"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            + 1)
        .to_string()
    );
    let bytes = encode_value(
        &schema(),
        "transaction",
        &unsigned(&action["act"], "2030-01-01T00:00:00"),
        &profile(),
    )
    .unwrap();
    user[1]["id"] = json!(hash(&bytes));
    user[1]["partial"][1]["expiration"] = json!("2030-01-01T00:00:00");
    fixture.traces.as_array_mut().unwrap().push(user);
    fixture.block["transactions"]
        .as_array_mut()
        .unwrap()
        .push(packed(&bytes, 0));
    bytes
}

#[test]
fn retained_original_members_and_native_schema_are_bound_to_their_sources() {
    let manifest: Value =
        serde_json::from_slice(&fs::read(fixture_root().join("manifest.json")).unwrap()).unwrap();
    assert_eq!(
        manifest["originalArchiveSha256"],
        "42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7"
    );
    assert_eq!(
        manifest["originalManifestSha256"],
        "fa48079240a25d6fddfe80b83539bf0735be0f03b034dd816205c7e815d2d305"
    );
    for member in manifest["members"].as_array().unwrap() {
        let bytes = fs::read(fixture_root().join(member["path"].as_str().unwrap())).unwrap();
        assert_eq!(bytes.len() as u64, member["bytes"].as_u64().unwrap());
        assert_eq!(hash(&bytes), member["sha256"]);
    }
    assert_eq!(hash(schema_json().as_bytes()), manifest["schema"]["sha256"]);
    let native: Value =
        serde_json::from_str(include_str!("../src/codec/native_action_abi.json")).unwrap();
    let original = schema();
    for category in ["types", "structs", "variants"] {
        for entry in native[category].as_array().unwrap() {
            if entry["name"] == "wire_native_onblock_v1" {
                continue;
            }
            let found = original[category]
                .as_array()
                .unwrap()
                .iter()
                .find(|original| {
                    if category == "types" {
                        original["new_type_name"] == entry["new_type_name"]
                    } else {
                        original["name"] == entry["name"]
                    }
                })
                .unwrap();
            assert_eq!(entry, found);
        }
    }
}

#[test]
fn explicit_native_profile_preserves_original_decisions_values_and_complete_pins() {
    let selected = CodecProfile::for_id("wire-sysio-6508c9e8-native-engineering-v1").unwrap();
    assert_eq!(
        CodecProfile::default().id,
        "wire-sysio-6508c9e8-engineering-v1"
    );
    let mut changed = vec![selected.clone(); 5];
    changed[0].id.push_str("-changed");
    changed[1].upstream_revision.push_str("-changed");
    changed[2].epoch_milliseconds += 1;
    changed[3].slot_milliseconds += 1;
    changed[4].slug_name_builtin = false;
    for number in [33, 122, 397] {
        let fixture = fixture(number);
        let raw = unhex(fixture.expected["rawHex"].as_str().unwrap());
        assert_eq!(
            observe_native_actions(&fixture.input, &fixture.source, &selected).unwrap(),
            observe_native_actions(&fixture.input, &fixture.source, &profile()).unwrap()
        );
        assert_eq!(
            decode_native_value(ONBLOCK_KIND, &raw, &selected).unwrap(),
            fixture.expected["expectedValue"]
        );
        assert_eq!(
            encode_native_value(ONBLOCK_KIND, &fixture.expected["expectedValue"], &selected)
                .unwrap(),
            raw
        );
        for invalid in &changed {
            assert!(observe_native_actions(&fixture.input, &fixture.source, invalid).is_err());
            assert!(decode_native_value(ONBLOCK_KIND, &raw, invalid).is_err());
            assert!(
                encode_native_value(ONBLOCK_KIND, &fixture.expected["expectedValue"], invalid)
                    .is_err()
            );
        }
    }
}

#[test]
fn original_three_cases_use_implicit_native_designations_and_official_value_oracles() {
    let profile = profile();
    let abi = schema();
    let deployed = decode_abi(
        &fs::read(fixture_root().join("deployed-sysio-32.abi.bin")).unwrap(),
        &profile,
    )
    .unwrap();
    for number in [33, 122, 397] {
        let fixture = fixture(number);
        let raw = unhex(fixture.expected["rawHex"].as_str().unwrap());
        assert_eq!(hash(&raw), fixture.expected["rawSha256"]);
        assert!(decode_value(&deployed, "onblock", &raw, &profile).is_err());
        let value = decode_native_value(ONBLOCK_KIND, &raw, &profile).unwrap();
        assert_eq!(value, fixture.expected["expectedValue"]);
        assert_eq!(
            encode_native_value(ONBLOCK_KIND, &value, &profile).unwrap(),
            raw
        );
        let facts = observe_native_actions(&fixture.input, &fixture.source, &profile).unwrap();
        assert_eq!(
            facts["decisions"][0],
            json!({"origin":{"transactionId":fixture.expected["transactionId"],"actionOrdinal":1,
            "rawSha256":fixture.expected["rawSha256"]},"kind":"native","nativeKind":ONBLOCK_KIND})
        );
        let previous_frame =
            fs::read(fixture_root().join(format!("block-{:06}.bin", number - 1))).unwrap();
        let previous = decode_value(&abi, "result", &previous_frame, &profile).unwrap();
        assert!(
            previous[1]["block"]
                .as_str()
                .unwrap()
                .starts_with(fixture.expected["rawHex"].as_str().unwrap())
        );
        assert_eq!(
            previous[1]["this_block"]["block_id"],
            fixture.source["previousBlockId"]
        );
    }
}

#[test]
fn native_value_codec_rejects_extra_or_missing_bytes_unknown_kinds_and_unqualified_profiles() {
    for number in [33, 122, 397] {
        let fixture = fixture(number);
        let raw = unhex(fixture.expected["rawHex"].as_str().unwrap());
        let mut appended = raw.clone();
        appended.push(0);
        for bytes in [appended, raw[..raw.len() - 1].to_vec()] {
            assert!(decode_native_value(ONBLOCK_KIND, &bytes, &profile()).is_err());
        }
        assert!(decode_native_value("onblock", &raw, &profile()).is_err());
        assert!(encode_native_value(ONBLOCK_KIND, &json!({"header":{}}), &profile()).is_err());
        assert!(
            decode_native_value(
                ONBLOCK_KIND,
                &raw,
                &CodecProfile::for_id("wire-sysio-7dede884-engineering-v1").unwrap()
            )
            .is_err()
        );
    }
}

#[test]
fn missing_or_foreign_source_position_schema_and_sections_fail_globally() {
    for name in ["chainId", "blockNum", "blockId", "previousBlockId"] {
        let mut fixture = fixture(33);
        fixture.source[name] = Value::Null;
        assert!(observe_native_actions(&fixture.input, &fixture.source, &profile()).is_err());
    }
    for name in ["blockId", "previousBlockId"] {
        let mut fixture = fixture(33);
        fixture.source[name] = json!("11".repeat(32));
        assert!(observe_native_actions(&fixture.input, &fixture.source, &profile()).is_err());
    }
    let mut fixture = fixture(33);
    fixture.source["blockNum"] = json!(34);
    assert!(observe_native_actions(&fixture.input, &fixture.source, &profile()).is_err());
    fixture = self::fixture(33);
    fixture.input["schemaJson"] = json!(schema_json() + " ");
    assert!(observe_native_actions(&fixture.input, &fixture.source, &profile()).is_err());
    for key in ["blockHex", "tracesHex"] {
        let mut fixture = self::fixture(33);
        fixture.input[key] = json!(fixture.input[key].as_str().unwrap().to_owned() + "00");
        assert!(observe_native_actions(&fixture.input, &fixture.source, &profile()).is_err());
        fixture.input[key] = Value::Null;
        assert!(observe_native_actions(&fixture.input, &fixture.source, &profile()).is_err());
    }
}

#[test]
fn partial_header_authorization_identity_and_payload_fail_only_the_candidate_origin() {
    for edit in ["partial", "authorization", "id", "payload", "name"] {
        let mut fixture = fixture(33);
        add_user(&mut fixture);
        match edit {
            "partial" => fixture.traces[0][1]["partial"][1]["ref_block_num"] = json!(1),
            "authorization" => {
                fixture.traces[0][1]["action_traces"][0][1]["act"]["authorization"][0]["actor"] =
                    json!("alice")
            }
            "id" => fixture.traces[0][1]["id"] = json!("11".repeat(32)),
            "payload" => {
                fixture.traces[0][1]["action_traces"][0][1]["act"]["data"] =
                    json!(fixture.expected["rawHex"].as_str().unwrap().to_owned() + "00")
            }
            "name" => fixture.traces[0][1]["action_traces"][0][1]["act"]["name"] = json!("other"),
            _ => unreachable!(),
        }
        constructed(&mut fixture);
        let result = incomplete(&fixture, "native_source_invalid");
        assert_eq!(result["decisions"][1]["kind"], "contract");
    }
}

#[test]
fn identical_same_name_user_and_inline_inputs_are_contract_origins() {
    let mut fixture = fixture(33);
    add_user(&mut fixture);
    constructed(&mut fixture);
    let facts = observe_native_actions(&fixture.input, &fixture.source, &profile()).unwrap();
    assert_eq!(facts["decisions"][0]["kind"], "native");
    assert_eq!(facts["decisions"][1]["kind"], "contract");
    fixture = self::fixture(33);
    let mut inline = fixture.traces[0][1]["action_traces"][0].clone();
    inline[1]["action_ordinal"] = json!(2);
    inline[1]["creator_action_ordinal"] = json!(1);
    inline[1]["receipt"][1]["global_sequence"] = json!("42");
    fixture.traces[0][1]["action_traces"]
        .as_array_mut()
        .unwrap()
        .push(inline);
    constructed(&mut fixture);
    let facts = observe_native_actions(&fixture.input, &fixture.source, &profile()).unwrap();
    assert_eq!(facts["decisions"][0]["kind"], "native");
    assert_eq!(facts["decisions"][1]["kind"], "contract");
}

#[test]
fn notifications_keep_only_the_verified_first_receiver_designation() {
    let mut fixture = fixture(33);
    let mut notification = fixture.traces[0][1]["action_traces"][0].clone();
    notification[1]["action_ordinal"] = json!(2);
    notification[1]["creator_action_ordinal"] = json!(1);
    notification[1]["receiver"] = json!("alice");
    notification[1]["receipt"][1]["receiver"] = json!("alice");
    notification[1]["receipt"][1]["global_sequence"] = json!("42");
    fixture.traces[0][1]["action_traces"]
        .as_array_mut()
        .unwrap()
        .push(notification);
    constructed(&mut fixture);
    let facts = observe_native_actions(&fixture.input, &fixture.source, &profile()).unwrap();
    assert_eq!(facts["decisions"].as_array().unwrap().len(), 1);
    assert_eq!(facts["decisions"][0]["kind"], "native");
}

#[test]
fn implicit_id_cannot_also_be_present_in_uncompressed_or_compressed_user_membership() {
    for compression in [0, 1] {
        let mut fixture = fixture(33);
        let transaction = unsigned(
            &fixture.traces[0][1]["action_traces"][0][1]["act"],
            "1970-01-01T00:00:00",
        );
        let bytes = encode_value(&schema(), "transaction", &transaction, &profile()).unwrap();
        let bytes = if compression == 1 {
            compress(&bytes)
        } else {
            bytes
        };
        fixture.block["transactions"]
            .as_array_mut()
            .unwrap()
            .push(packed(&bytes, compression));
        constructed(&mut fixture);
        incomplete(&fixture, "native_source_invalid");
    }
}

#[test]
fn bounded_compressed_user_membership_is_supported_but_unknown_truncated_and_trailing_forms_are_not()
 {
    for edit in [
        "valid",
        "unknown",
        "truncated",
        "trailing",
        "noncanonical",
        "duplicate",
    ] {
        let mut fixture = fixture(33);
        let bytes = add_user(&mut fixture);
        let mut compressed = compress(&bytes);
        let mut compression = 1;
        match edit {
            "unknown" => compression = 2,
            "truncated" => {
                compressed.pop();
            }
            "trailing" => compressed.push(0),
            "noncanonical" => {
                let mut bytes = bytes;
                bytes[13] = 0x80;
                bytes.insert(14, 0);
                compressed = compress(&bytes);
            }
            "valid" | "duplicate" => (),
            _ => unreachable!(),
        }
        fixture.block["transactions"][0] = packed(&compressed, compression);
        if edit == "duplicate" {
            let duplicate = fixture.block["transactions"][0].clone();
            fixture.block["transactions"]
                .as_array_mut()
                .unwrap()
                .push(duplicate);
        }
        constructed(&mut fixture);
        if edit == "valid" {
            let facts =
                observe_native_actions(&fixture.input, &fixture.source, &profile()).unwrap();
            assert_eq!(facts["decisions"][0]["kind"], "native");
            assert_eq!(facts["decisions"][1]["kind"], "contract");
        } else {
            let code = if edit == "unknown" {
                "native_source_unsupported"
            } else {
                "native_source_invalid"
            };
            let facts = incomplete(&fixture, code);
            assert_eq!(facts["decisions"][1]["kind"], "contract");
        }
    }
}

#[test]
fn over_budget_inflation_is_stopped_before_transaction_decoding() {
    let mut fixture = fixture(33);
    let compressed = compress(&vec![0; 10 * 1024 * 1024 + 1]);
    fixture.block["transactions"]
        .as_array_mut()
        .unwrap()
        .push(packed(&compressed, 1));
    constructed(&mut fixture);
    incomplete(&fixture, "native_source_limits");
}

#[test]
fn aggregate_compressed_membership_budget_is_separate_from_each_packed_limit() {
    // Constructed resource control, not a claim that these receipts were accepted by a node.
    let mut fixture = fixture(33);
    let mut transaction = unsigned(
        &fixture.traces[0][1]["action_traces"][0][1]["act"],
        "2030-01-01T00:00:00",
    );
    transaction["actions"][0]["data"] = json!("00".repeat(6 * 1024 * 1024));
    for index in 0..3 {
        transaction["ref_block_prefix"] = json!(index);
        let bytes = encode_value(&schema(), "transaction", &transaction, &profile()).unwrap();
        assert!(bytes.len() < 10 * 1024 * 1024);
        fixture.block["transactions"]
            .as_array_mut()
            .unwrap()
            .push(packed(&compress(&bytes), 1));
    }
    constructed(&mut fixture);
    incomplete(&fixture, "native_source_limits");
}
