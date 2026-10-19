use hyperion_wire_protocol::{
    ProtocolError, normalize_kv_record, slot_to_unix_milliseconds, unix_milliseconds_to_slot,
};
use serde_json::{Value, json};

fn source() -> Value {
    json!({
        "chainId": "11".repeat(32),
        "blockId": "22".repeat(32),
        "blockNum": 10,
        "ordinal": 0,
        "abiDeployment": "test:account:deployment:1"
    })
}

fn row(key: &str) -> Value {
    json!({
        "kind": "contract_row_kv", "present": true,
        "code": "18446744073709551615", "payer": "0", "tableId": 0,
        "keyHex": key, "valueHex": "00ff"
    })
}

#[test]
fn compound_keys_do_not_collide_and_updates_keep_identity() {
    let input = row("01000200");
    let provenance = source();
    let first = normalize_kv_record(&input, &provenance).unwrap();
    let other = normalize_kv_record(&row("01000300"), &provenance).unwrap();
    assert_ne!(first["identity"], other["identity"]);

    let mut deletion = input.clone();
    deletion["present"] = json!(false);
    let mut later = provenance.clone();
    later["blockNum"] = json!(11);
    later["blockId"] = json!("33".repeat(32));
    later["ordinal"] = json!(4);
    later["abiDeployment"] = json!("test:account:deployment:2");
    let deleted = normalize_kv_record(&deletion, &later).unwrap();
    assert_eq!(first["identity"], deleted["identity"]);
    assert_eq!(deleted["record"], deletion);
    assert_eq!(deleted["record"]["valueHex"], "00ff");
    assert_eq!(deleted["source"], later);
    assert_eq!(input, row("01000200"));
    assert_eq!(provenance, source());
}

#[test]
fn index_identity_preserves_both_keys_and_chain_namespace() {
    let mut input = json!({
        "kind": "contract_index_kv", "present": false, "code": "1", "payer": "2", "tableId": 65535,
        "secondaryKeyHex": "00", "primaryKeyHex": "0100"
    });
    let provenance = source();
    let first = normalize_kv_record(&input, &provenance).unwrap();
    let mut new_payer = input.clone();
    new_payer["payer"] = json!("18446744073709551615");
    let payer_change = normalize_kv_record(&new_payer, &provenance).unwrap();
    assert_eq!(first["identity"], payer_change["identity"]);
    assert_eq!(payer_change["record"]["payer"], new_payer["payer"]);
    input["primaryKeyHex"] = json!("0101");
    let other = normalize_kv_record(&input, &provenance).unwrap();
    assert_ne!(first["identity"], other["identity"]);
    let mut other_chain = provenance.clone();
    other_chain["chainId"] = json!("44".repeat(32));
    let other = normalize_kv_record(&input, &other_chain).unwrap();
    assert_ne!(first["identity"], other["identity"]);
    input["secondaryKeyHex"] = json!("");
    input["primaryKeyHex"] = json!("");
    assert!(
        normalize_kv_record(&input, &provenance).unwrap()["identity"]
            .as_str()
            .unwrap()
            .ends_with(":65535::")
    );
}

#[test]
fn exact_shapes_and_canonical_numeric_text_are_required() {
    let provenance = source();
    let mut input = row("");
    input["unhandledSourceField"] = json!("must not be silently lost");
    assert_eq!(
        normalize_kv_record(&input, &provenance),
        Err(ProtocolError::InvalidRecord)
    );
    for invalid in ["01", "18446744073709551616", "+1", "1e1", "", "-1"] {
        let mut input = row("");
        input["code"] = json!(invalid);
        assert_eq!(
            normalize_kv_record(&input, &provenance),
            Err(ProtocolError::InvalidRecord),
            "{invalid}"
        );
    }
    let mut bad_source = provenance;
    bad_source["unhandledSourceField"] = json!(0);
    assert_eq!(
        normalize_kv_record(&row(""), &bad_source),
        Err(ProtocolError::InvalidSource)
    );
    assert_eq!(
        normalize_kv_record(&json!(null), &bad_source),
        Err(ProtocolError::InvalidRecord)
    );
}

#[test]
fn explicit_boundary_whitespace_is_portable() {
    for c in ['\u{0085}', '\u{feff}', '\u{2009}', '\n', ' '] {
        for deployment in [format!("{c}valid"), format!("valid{c}")] {
            let mut provenance = source();
            provenance["abiDeployment"] = json!(deployment);
            assert_eq!(
                normalize_kv_record(&row(""), &provenance),
                Err(ProtocolError::InvalidSource)
            );
        }
    }
    let mut provenance = source();
    provenance["abiDeployment"] = json!("deployment with internal whitespace");
    assert!(normalize_kv_record(&row(""), &provenance).is_ok());
}

#[test]
fn timestamps_reject_rounding_but_accept_integral_json_numbers() {
    for slot in [0, 1, 172_800, u32::MAX] {
        let ms = slot_to_unix_milliseconds(&json!(slot)).unwrap();
        assert_eq!(unix_milliseconds_to_slot(&json!(ms)), Ok(slot));
        assert_eq!(
            unix_milliseconds_to_slot(&json!(ms + 1)),
            Err(ProtocolError::InvalidTimestamp)
        );
    }
    assert_eq!(
        slot_to_unix_milliseconds(&serde_json::from_str::<Value>("1.0").unwrap()),
        slot_to_unix_milliseconds(&json!(1))
    );
    assert_eq!(
        slot_to_unix_milliseconds(&serde_json::from_str::<Value>("-0").unwrap()),
        slot_to_unix_milliseconds(&json!(0))
    );
    for slot in [json!(-1), json!(0.5), json!(4_294_967_296u64), json!("0")] {
        assert_eq!(
            slot_to_unix_milliseconds(&slot),
            Err(ProtocolError::InvalidSlot)
        );
    }
}
