use hyperion_wire_protocol::{protocol_profile, run_operation};
use serde_json::Value;

#[test]
fn shared_engineering_vectors() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../fixtures/protocol-vectors.json")).unwrap();
    assert_eq!(fixtures["schemaVersion"], 1);
    assert_eq!(&fixtures["profile"], protocol_profile());
    assert_eq!(
        protocol_profile()["epochMilliseconds"],
        1_735_689_600_000u64
    );
    assert_eq!(protocol_profile()["slotMilliseconds"], 500);
    let vectors = fixtures["vectors"].as_array().unwrap();
    assert!(!vectors.is_empty());
    for vector in vectors {
        let operation = vector["operation"].as_str().unwrap();
        let result = run_operation(operation, &vector["input"]);
        if let Some(code) = vector.get("expectedError") {
            assert_eq!(
                result.unwrap_err().code(),
                code.as_str().unwrap(),
                "vector {}",
                vector["id"]
            );
        } else {
            assert_eq!(
                result.unwrap(),
                vector["expected"],
                "vector {}",
                vector["id"]
            );
        }
    }
}
