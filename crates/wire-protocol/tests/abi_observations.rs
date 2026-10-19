use hyperion_wire_protocol::codec::observations::observe_block_abi;
use hyperion_wire_protocol::codec::{CodecProfile, decode_value, encode_value};
use serde_json::{Value, json};

fn source() -> Value {
    json!({"chainId":"11".repeat(32),"blockId":"22".repeat(32),
        "previousBlockId":"33".repeat(32),"blockNum":12})
}

fn physical() -> Value {
    json!({"version":"sysio::abi/1.3","structs":[
        {"name":"account_v0","base":"","fields":[
            {"name":"name","type":"name"},
            {"name":"creation_date","type":"block_timestamp_type"},
            {"name":"abi","type":"bytes"}]}],
        "variants":[{"name":"account","types":["account_v0"]}]})
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn native_payload(account: &str, abi: &[u8], profile: &CodecProfile) -> String {
    let mut bytes = encode_value(&physical(), "name", &json!(account), profile).unwrap();
    assert!(abi.len() < 128);
    bytes.push(abi.len() as u8);
    bytes.extend_from_slice(abi);
    hex(&bytes)
}

fn action(ordinal: u32, creator: u32, sequence: &str, account: &str, name: &str) -> Value {
    json!(["action_trace_v1",{
        "action_ordinal":ordinal,"creator_action_ordinal":creator,
        "receipt":["action_receipt_v0",{"receiver":account,
            "global_sequence":sequence,"abi_sequence":7}],
        "receiver":account,"context_free":false,"except":null,"error_code":null,
        "act":{"account":account,"name":name,"data":"00",
            "authorization":[{"actor":account,"permission":"active"}]}
    }])
}

fn transaction(actions: Vec<Value>) -> Value {
    json!(["transaction_trace_v0",{"id":"44".repeat(32),"status":0,
        "scheduled":false,"failed_dtrx_trace":null,"except":null,"error_code":null,
        "action_traces":actions}])
}

fn input(actions: Vec<Value>) -> Value {
    json!({"traces":[transaction(actions)],"accountRows":[]})
}

#[test]
fn inline_execution_precedes_later_top_level_allocation_at_both_profiles() {
    for id in [
        "wire-sysio-6508c9e8-engineering-v1",
        "wire-sysio-7dede884-engineering-v1",
    ] {
        let profile = CodecProfile::for_id(id).unwrap();
        let mut inline = action(3, 1, "11", "sysio", "setabi");
        inline[1]["act"]["data"] = json!(native_payload("alice", &[0xff], &profile));
        let data = input(vec![
            action(1, 0, "10", "alice", "start"),
            action(2, 0, "12", "alice", "finish"),
            inline,
        ]);
        let original = data.clone();
        let facts = observe_block_abi(&data, &source(), &profile).unwrap();
        let ordinals = facts["actionInputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|fact| fact["actionOrdinal"].as_u64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ordinals, [1, 3, 2]);
        assert_eq!(facts["deployments"][0]["account"], "alice");
        assert_eq!(facts["deployments"][0]["abiHex"], "ff");
        assert_eq!(facts["deployments"][0]["globalSequence"], "11");
        assert_eq!(data, original);
    }
}

#[test]
fn self_setabi_notification_reuses_original_input_without_a_second_publication() {
    let profile = CodecProfile::default();
    let mut first = action(1, 0, "18446744073709551614", "sysio", "setabi");
    first[1]["act"]["data"] = json!(native_payload("sysio", &[], &profile));
    first[1]["receipt"][1]["abi_sequence"] = json!(8);
    let mut notification = first.clone();
    notification[1]["action_ordinal"] = json!(2);
    notification[1]["creator_action_ordinal"] = json!(1);
    notification[1]["receiver"] = json!("alice");
    notification[1]["receipt"][1]["receiver"] = json!("alice");
    notification[1]["receipt"][1]["global_sequence"] = json!(u64::MAX.to_string());
    let data = input(vec![notification, first]);
    let facts = observe_block_abi(&data, &source(), &profile).unwrap();
    assert_eq!(facts["actionInputs"][0]["inputActionOrdinal"], 1);
    assert_eq!(facts["actionInputs"][1]["inputActionOrdinal"], 1);
    assert_eq!(facts["actionInputs"][0]["receiptAbiSequence"], "8");
    assert_eq!(facts["deployments"].as_array().unwrap().len(), 1);
    assert_eq!(facts["deployments"][0]["abiHex"], "");
    assert_eq!(facts["deployments"][0]["effect"], "native-before-receipt");
}

#[test]
fn native_prefix_accepts_trailing_overlong_and_fifth_byte_truncation() {
    let profile = CodecProfile::default();
    let account = hex(&encode_value(&physical(), "name", &json!("alice"), &profile).unwrap());
    for (suffix, expected) in [
        ("00deadbeef", ""),
        ("8000deadbeef", ""),
        ("8200aaffdeadbeef", "aaff"),
        ("8080808070deadbeef", ""),
        ("80808080f0deadbeef", ""),
    ] {
        let mut mutation = action(1, 0, "1", "sysio", "setabi");
        mutation[1]["act"]["data"] = json!(format!("{account}{suffix}"));
        let facts = observe_block_abi(&input(vec![mutation]), &source(), &profile).unwrap();
        assert_eq!(facts["deployments"][0]["abiHex"], expected);
        assert_eq!(
            facts["actionInputs"][0]["rawHex"],
            format!("{account}{suffix}")
        );
    }
}

#[test]
fn repeated_publications_and_opaque_final_deletion_keep_all_source_facts() {
    let profile = CodecProfile::default();
    let mut first = action(1, 0, "2", "sysio", "setabi");
    first[1]["act"]["data"] = json!(native_payload("alice", &[0xff], &profile));
    let mut second = first.clone();
    second[1]["action_ordinal"] = json!(2);
    second[1]["receipt"][1]["global_sequence"] = json!("3");
    let value = json!(["account_v0",{"name":"alice",
        "creation_date":"2025-01-01T00:00:00.000","abi":"ff"}]);
    let raw = encode_value(&physical(), "account", &value, &profile).unwrap();
    let canonical_value = decode_value(&physical(), "account", &raw, &profile).unwrap();
    let mut data = input(vec![first, second]);
    data["accountRows"] = json!([{"ordinal":17,"present":false,
        "rawHex":hex(&raw),"value":canonical_value}]);
    let facts = observe_block_abi(&data, &source(), &profile).unwrap();
    assert_eq!(facts["deployments"].as_array().unwrap().len(), 2);
    assert_eq!(
        facts["finalStates"][0],
        json!({"account":"alice",
        "present":false,"abiHex":"ff","deltaOrdinal":17})
    );
    data["accountRows"][0]["value"][1]["creation_date"] = json!("2025-01-01T00:00:00.500");
    assert!(observe_block_abi(&data, &source(), &profile).is_err());
}

#[test]
fn failed_deferred_and_unknown_transaction_semantics_never_publish() {
    let profile = CodecProfile::default();
    let data = input(vec![action(1, 0, "1", "alice", "run")]);
    for status in [1, 2, 3, 4, 5, 255] {
        let mut bad = data.clone();
        bad["traces"][0][1]["status"] = json!(status);
        assert_eq!(
            observe_block_abi(&bad, &source(), &profile)
                .unwrap_err()
                .code(),
            "unsupported_feature"
        );
    }
    for (field, value) in [
        ("scheduled", json!(true)),
        ("failed_dtrx_trace", transaction(vec![])),
        ("except", json!("rolled back")),
        ("error_code", json!("1")),
    ] {
        let mut bad = data.clone();
        bad["traces"][0][1][field] = value;
        assert!(observe_block_abi(&bad, &source(), &profile).is_err());
    }
    let mut missing = data;
    missing["traces"][0][1]["action_traces"][0][1]["receipt"] = Value::Null;
    assert!(observe_block_abi(&missing, &source(), &profile).is_err());
}

#[test]
fn invalid_identity_ancestry_and_unsafe_sequences_fail() {
    let profile = CodecProfile::default();
    let first = action(1, 0, "1", "alice", "run");
    let mut second = action(2, 1, "2", "alice", "run");
    second[1]["receiver"] = json!("bob");
    second[1]["receipt"][1]["receiver"] = json!("bob");
    let good = input(vec![first, second]);
    assert!(observe_block_abi(&good, &source(), &profile).is_ok());
    for (field, value) in [
        ("creator_action_ordinal", json!(0)),
        ("creator_action_ordinal", json!(3)),
        ("creator_action_ordinal", json!(2)),
        ("context_free", json!(true)),
        ("action_ordinal", json!(1)),
    ] {
        let mut bad = good.clone();
        bad["traces"][0][1]["action_traces"][1][1][field] = value;
        assert!(observe_block_abi(&bad, &source(), &profile).is_err());
    }
    let mut bad = good.clone();
    bad["traces"][0][1]["action_traces"][1][1]["act"]["authorization"][0]["actor"] = json!("bob");
    assert!(observe_block_abi(&bad, &source(), &profile).is_err());
    for sequence in [
        json!(2),
        json!("0"),
        json!("01"),
        json!("18446744073709551616"),
        json!("1"),
    ] {
        let mut bad = good.clone();
        bad["traces"][0][1]["action_traces"][1][1]["receipt"][1]["global_sequence"] = sequence;
        assert!(observe_block_abi(&bad, &source(), &profile).is_err());
    }
}

#[test]
fn missing_is_not_empty_and_malformed_fields_return_errors_without_panics() {
    let profile = CodecProfile::default();
    let empty = json!({"traces":[],"accountRows":[]});
    assert_eq!(
        observe_block_abi(&empty, &source(), &profile).unwrap(),
        json!({"schemaVersion":1,"actionInputs":[],"deployments":[],"finalStates":[]})
    );
    for malformed in [
        json!({}),
        json!({"traces":[]}),
        json!({"accountRows":[]}),
        json!({"traces":[["transaction_trace_v0",{}]],"accountRows":[]}),
    ] {
        assert!(observe_block_abi(&malformed, &source(), &profile).is_err());
    }
    let mut empty_names = action(1, 0, "1", "", "");
    empty_names[1]["act"]["authorization"] = json!([{"actor":"","permission":""}]);
    assert!(observe_block_abi(&input(vec![empty_names]), &source(), &profile).is_ok());
    let mut missing = source();
    missing.as_object_mut().unwrap().remove("previousBlockId");
    assert!(observe_block_abi(&empty, &missing, &profile).is_err());
    missing["previousBlockId"] = Value::Null;
    assert!(observe_block_abi(&empty, &missing, &profile).is_ok());
}

#[test]
fn captured_ship_codec_output_enters_the_observer_with_numeric_wire_flags() {
    let abi: Value =
        serde_json::from_str(include_str!("../../../fixtures/codec/ship.abi.json")).unwrap();
    let vectors: Value =
        serde_json::from_str(include_str!("../../../fixtures/codec/ship-vectors.json")).unwrap();
    let capture = vectors["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|vector| vector["id"] == "captured-ship-traces")
        .unwrap();
    let hex = capture["hex"].as_str().unwrap();
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
        .collect::<Vec<_>>();
    for id in [
        "wire-sysio-6508c9e8-engineering-v1",
        "wire-sysio-7dede884-engineering-v1",
    ] {
        let profile = CodecProfile::for_id(id).unwrap();
        let traces = decode_value(&abi, "transaction_trace[]", &bytes, &profile).unwrap();
        assert_eq!(traces[0][1]["scheduled"], 0);
        assert_eq!(traces[0][1]["action_traces"][0][1]["context_free"], 0);
        let data = json!({"traces":traces,"accountRows":[]});
        let facts = observe_block_abi(&data, &source(), &profile).unwrap();
        assert_eq!(facts["actionInputs"].as_array().unwrap().len(), 1);
        assert_eq!(facts["actionInputs"][0]["name"], "onblock");
        assert_eq!(facts["actionInputs"][0]["globalSequence"], "6349");
        assert_eq!(facts["actionInputs"][0]["inputActionOrdinal"], 1);
        assert!(facts["deployments"].as_array().unwrap().is_empty());
        let mut scheduled = data.clone();
        scheduled["traces"][0][1]["scheduled"] = json!(1);
        assert_eq!(
            observe_block_abi(&scheduled, &source(), &profile)
                .unwrap_err()
                .code(),
            "unsupported_feature"
        );
        let mut bad_context = data;
        bad_context["traces"][0][1]["action_traces"][0][1]["context_free"] = json!(2);
        assert_eq!(
            observe_block_abi(&bad_context, &source(), &profile)
                .unwrap_err()
                .code(),
            "invalid_value"
        );
    }
}
