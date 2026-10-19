#!/usr/bin/env python3
"""Regenerate fixed contract vectors; no node, network, or external packages.

These are synthetic, source-derived examples for the package-local primitives.
They are not captured SHiP frames, binary-ABI fixtures, or testnet evidence.
The expected normalization format is the explicit Wire #1 contract. No runtime
implementation is imported to calculate expected results.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PROFILE = {
    "id": "wire-sysio-6508c9e8-engineering-v1",
    "epochMilliseconds": 1735689600000,
    "slotMilliseconds": 500,
    "upstreamRevision": "6508c9e8f4044df8d5acb082a7af3be6a80cd9a0",
}
CHAIN = "aa" * 32
SOURCE = {
    "chainId": CHAIN,
    "blockId": "bb" * 32,
    "blockNum": 7,
    "ordinal": 3,
    "abiDeployment": "abi:deployment-1",
}
ROW = {
    "kind": "contract_row_kv",
    "present": True,
    "code": "6138663577826885632",
    "payer": "3773036822876127232",
    "tableId": 54886,
    "keyHex": "010203040000000000000001",
    "valueHex": "0010ff",
}
INDEX = {
    "kind": "contract_index_kv",
    "present": True,
    "code": ROW["code"],
    "payer": ROW["payer"],
    "tableId": 37799,
    "secondaryKeyHex": "01020304",
    "primaryKeyHex": ROW["keyHex"],
}


def vector_set() -> list[dict]:
    vectors: list[dict] = []

    def success(identifier: str, operation: str, value: object, expected: object) -> None:
        vectors.append({"id": identifier, "operation": operation,
                        "input": copy.deepcopy(value), "expected": copy.deepcopy(expected)})

    def error(identifier: str, operation: str, value: object, code: str) -> None:
        vectors.append({"id": identifier, "operation": operation,
                        "input": copy.deepcopy(value), "expectedError": code})

    # Explicit independent timestamp arithmetic examples, including both endpoints.
    slots = [(0, 1735689600000), (1, 1735689600500), (2, 1735689601000),
             (172800, 1735776000000), (4294967294, 3883173247000),
             (4294967295, 3883173247500)]
    for slot, timestamp in slots:
        success(f"slot-{slot}", "slotToUnixMilliseconds", slot, timestamp)
        success(f"timestamp-slot-{slot}", "unixMillisecondsToSlot", timestamp, slot)
    # JSON integral floats have the same numeric meaning in both implementations.
    success("slot-integral-float", "slotToUnixMilliseconds", 1.0, 1735689600500)
    success("slot-negative-zero", "slotToUnixMilliseconds", -0.0, 1735689600000)
    success("timestamp-integral-float", "unixMillisecondsToSlot", 1735689600500.0, 1)

    for label, value in [
        ("negative", -1), ("past-u32", 4294967296), ("fractional", 0.5),
        ("unsafe-integer", 9007199254740992), ("very-large-finite", 1e308),
        ("null", None), ("boolean-true", True), ("boolean-false", False),
        ("decimal-string", "1"), ("empty-string", ""),
        ("array", [1]), ("object", {"slot": 1}),
    ]:
        error(f"invalid-slot-{label}", "slotToUnixMilliseconds", value, "invalid_slot")
    for label, value in [
        ("before-epoch", 1735689599999), ("after-maximum", 3883173247501),
        ("aligned-before-epoch", 1735689599500),
        ("aligned-after-maximum", 3883173248000),
        ("unaligned", 1735689600001), ("fractional", 1735689600000.5),
        ("unsafe-integer", 9007199254740992), ("very-large-finite", 1e308),
        ("null", None), ("boolean", True), ("decimal-string", "1735689600000"),
        ("array", [1735689600000]), ("object", {"milliseconds": 1735689600000}),
    ]:
        error(f"invalid-timestamp-{label}", "unixMillisecondsToSlot", value,
              "invalid_timestamp")

    # Identities below implement the stipulated text format, not a Wire decoder.
    def row_identity(key: str = ROW["keyHex"], *, chain: str = CHAIN,
                     code: str = ROW["code"], table: int = ROW["tableId"]) -> str:
        return f"wire-kv-v1:row:{chain}:{code}:{table}:{key}"

    def index_identity(secondary: str = INDEX["secondaryKeyHex"],
                       primary: str = INDEX["primaryKeyHex"], *, chain: str = CHAIN,
                       code: str = INDEX["code"], table: int = INDEX["tableId"]) -> str:
        return f"wire-kv-v1:index:{chain}:{code}:{table}:{secondary}:{primary}"

    def normalized(identifier: str, record: dict, source: dict, identity: str) -> None:
        success(identifier, "normalizeKvRecord", {"record": record, "source": source},
                {"identity": identity, "record": record, "source": source})

    normalized("row-insert", ROW, SOURCE, row_identity())
    normalized("row-delete-retains-value-and-identity", {**ROW, "present": False},
               SOURCE, row_identity())
    normalized("row-update-retains-identity", {**ROW, "valueHex": "1020"},
               SOURCE, row_identity())
    normalized("row-payer-change-retains-identity", {**ROW, "payer": "0"},
               SOURCE, row_identity())
    normalized("row-abi-change-retains-identity", ROW,
               {**SOURCE, "abiDeployment": "abi:deployment-2"}, row_identity())
    normalized("row-block-change-retains-identity", ROW,
               {**SOURCE, "blockId": "cc" * 32, "blockNum": 8, "ordinal": 0},
               row_identity())
    normalized("row-source-ordinal-change-retains-identity", ROW,
               {**SOURCE, "ordinal": 4294967295}, row_identity())
    normalized("row-complete-compound-key-a", ROW, SOURCE, row_identity())
    compound_b = "010203040000000000000002"
    normalized("row-complete-compound-key-b", {**ROW, "keyHex": compound_b}, SOURCE,
               row_identity(compound_b))
    normalized("row-empty-key-and-value", {**ROW, "keyHex": "", "valueHex": ""},
               SOURCE, row_identity(""))
    normalized("row-zero-table-id", {**ROW, "tableId": 0}, SOURCE,
               row_identity(table=0))
    normalized("row-negative-zero-table-id", {**ROW, "tableId": -0.0}, SOURCE,
               row_identity(table=0))
    normalized("row-max-table-id", {**ROW, "tableId": 65535}, SOURCE,
               row_identity(table=65535))
    normalized("row-zero-code-and-payer", {**ROW, "code": "0", "payer": "0"}, SOURCE,
               row_identity(code="0"))
    normalized("row-max-u64-code-and-payer",
               {**ROW, "code": "18446744073709551615", "payer": "18446744073709551615"},
               SOURCE, row_identity(code="18446744073709551615"))
    normalized("row-chain-namespace-separation", ROW, {**SOURCE, "chainId": "dd" * 32},
               row_identity(chain="dd" * 32))
    normalized("row-code-namespace-separation", {**ROW, "code": "1"}, SOURCE,
               row_identity(code="1"))
    normalized("row-table-namespace-separation", {**ROW, "tableId": 37799}, SOURCE,
               row_identity(table=37799))
    normalized("row-source-max-block-and-ordinal", ROW,
               {**SOURCE, "blockNum": 4294967295, "ordinal": 4294967295}, row_identity())
    normalized("row-source-ordinal-negative-zero", ROW,
               {**SOURCE, "ordinal": -0.0}, row_identity())
    normalized("row-source-integral-floats", ROW,
               {**SOURCE, "blockNum": 7.0, "ordinal": 3.0}, row_identity())
    normalized("row-abi-identifier-retained-verbatim", ROW,
               {**SOURCE, "abiDeployment": "wire:abi v1/deployment#7"}, row_identity())

    normalized("index-insert", INDEX, SOURCE, index_identity())
    normalized("index-delete-retains-identity", {**INDEX, "present": False}, SOURCE,
               index_identity())
    normalized("index-payer-change-retains-identity", {**INDEX, "payer": "0"}, SOURCE,
               index_identity())
    normalized("index-same-secondary-distinct-primary", {**INDEX, "primaryKeyHex": compound_b},
               SOURCE, index_identity(primary=compound_b))
    normalized("index-distinct-secondary-same-primary",
               {**INDEX, "secondaryKeyHex": "01020305"}, SOURCE,
               index_identity(secondary="01020305"))
    normalized("index-zero-table-id", {**INDEX, "tableId": 0}, SOURCE,
               index_identity(table=0))
    normalized("index-empty-keys", {**INDEX, "secondaryKeyHex": "", "primaryKeyHex": ""},
               SOURCE, index_identity(secondary="", primary=""))
    normalized("index-chain-namespace-separation", INDEX, {**SOURCE, "chainId": "dd" * 32},
               index_identity(chain="dd" * 32))
    normalized("index-code-namespace-separation", {**INDEX, "code": "1"}, SOURCE,
               index_identity(code="1"))
    normalized("index-table-namespace-separation", {**INDEX, "tableId": 54886}, SOURCE,
               index_identity(table=54886))
    normalized("index-abi-block-change-retains-identity", INDEX,
               {**SOURCE, "abiDeployment": "abi:deployment-2", "blockId": "cc" * 32,
                "blockNum": 8, "ordinal": 0}, index_identity())
    normalized("index-max-u64-code-and-payer",
               {**INDEX, "code": "18446744073709551615", "payer": "18446744073709551615"}, SOURCE,
               index_identity(code="18446744073709551615"))
    # Same table number and identical key bytes still cannot collide across kinds.
    same_keys = {**INDEX, "tableId": ROW["tableId"], "secondaryKeyHex": ROW["keyHex"],
                 "primaryKeyHex": ""}
    normalized("index-row-kind-separation", same_keys, SOURCE,
               index_identity(secondary=ROW["keyHex"], primary="", table=ROW["tableId"]))

    def bad_record(identifier: str, record: object) -> None:
        error(identifier, "normalizeKvRecord", {"record": record, "source": SOURCE},
              "invalid_record")

    def bad_source(identifier: str, source: object) -> None:
        error(identifier, "normalizeKvRecord", {"record": ROW, "source": source},
              "invalid_source")

    for label, value in [("null", None), ("array", []), ("string", "row"),
                         ("number", 1), ("boolean", True), ("empty-object", {})]:
        bad_record(f"invalid-record-shape-{label}", value)
        bad_source(f"invalid-source-shape-{label}", value)

    for kind, original in [("row", ROW), ("index", INDEX)]:
        for field in original:
            missing = {k: v for k, v in original.items() if k != field}
            bad_record(f"invalid-{kind}-missing-{field}", missing)
        bad_record(f"invalid-{kind}-extra-field", {**original, "unexpected": {"raw": "ff"}})
        for label, value in [("unknown", "contract_row"), ("null", None), ("number", 0)]:
            bad_record(f"invalid-{kind}-kind-{label}", {**original, "kind": value})
        for label, value in [("zero", 0), ("string", "true"), ("null", None)]:
            bad_record(f"invalid-{kind}-present-{label}", {**original, "present": value})
        for label, value in [("negative", -1), ("too-large", 65536), ("fractional", 0.5),
                             ("string", "0"), ("boolean", True), ("null", None),
                             ("unsafe-integer", 9007199254740992)]:
            bad_record(f"invalid-{kind}-table-id-{label}", {**original, "tableId": value})
        for label, value in [("empty", ""), ("leading-zero", "01"), ("negative", "-1"),
                             ("plus-sign", "+1"), ("leading-space", " 1"),
                             ("trailing-space", "1 "), ("trailing-newline", "1\n"),
                             ("unicode-digits", "\uff11\uff12"), ("decimal-fraction", "1.0"),
                             ("exponent", "1e3"), ("hex", "0xff"),
                             ("past-u64", "18446744073709551616"),
                             ("display-name", "alice"), ("number", 1), ("null", None)]:
            bad_record(f"invalid-{kind}-code-{label}", {**original, "code": value})
        for field in (["keyHex", "valueHex"] if kind == "row"
                      else ["secondaryKeyHex", "primaryKeyHex"]):
            for label, value in [("uppercase", "AB"), ("odd-length", "a"),
                                 ("invalid-character", "gg"), ("hex-prefix", "0x00"),
                                 ("leading-space", " 00"), ("trailing-space", "00 "),
                                 ("newline", "00\n"), ("number", 0), ("null", None)]:
                bad_record(f"invalid-{kind}-{field}-{label}", {**original, field: value})

    for kind, original in [("row", ROW), ("index", INDEX)]:
        for label, value in [("leading-zero", "00"), ("past-u64", "18446744073709551616"),
                             ("negative", "-1"), ("plus-sign", "+1"),
                             ("decimal-fraction", "1.0"), ("hex", "0xff"),
                             ("trailing-newline", "1\n"), ("display-name", "alice"),
                             ("number", 1), ("boolean", True), ("null", None)]:
            bad_record(f"invalid-{kind}-payer-{label}", {**original, "payer": value})

    for field in SOURCE:
        missing = {k: v for k, v in SOURCE.items() if k != field}
        bad_source(f"invalid-source-missing-{field}", missing)
    bad_source("invalid-source-extra-field", {**SOURCE, "unexpected": "raw-context"})
    for field in ["chainId", "blockId"]:
        for label, value in [("empty", ""), ("short", "aa" * 31), ("long", "aa" * 33),
                             ("uppercase", "AA" * 32), ("nonhex", "gg" * 32),
                             ("suffix-newline", "aa" * 32 + "\n"),
                             ("number", 0), ("null", None)]:
            bad_source(f"invalid-source-{field}-{label}", {**SOURCE, field: value})
    for field in ["blockNum", "ordinal"]:
        for label, value in [("negative", -1), ("past-u32", 4294967296),
                             ("fractional", 1.5), ("string", "1"), ("boolean", True),
                             ("unsafe-integer", 9007199254740992), ("null", None)]:
            bad_source(f"invalid-source-{field}-{label}", {**SOURCE, field: value})
    bad_source("invalid-source-block-zero", {**SOURCE, "blockNum": 0})
    for label, value in [("empty", ""), ("space-only", " "), ("leading-space", " abi1"),
                         ("trailing-space", "abi1 "), ("leading-newline", "\nabi1"),
                         ("trailing-newline", "abi1\n"), ("number", 1), ("null", None)]:
        bad_source(f"invalid-source-abi-deployment-{label}", {**SOURCE, "abiDeployment": value})

    # Explicit cross-language boundary-whitespace contract; no reliance on the
    # differing default trim/isspace character sets of JavaScript, Rust or Python.
    whitespace = [*range(0x0009, 0x000E), 0x0020, 0x0085, 0x00A0, 0x1680,
                  *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]
    for point in whitespace:
        for side, value in [("leading", chr(point) + "abi1"),
                            ("trailing", "abi1" + chr(point))]:
            bad_source(f"invalid-source-abi-{side}-u{point:04x}",
                       {**SOURCE, "abiDeployment": value})

    identifiers = [v["id"] for v in vectors]
    assert len(identifiers) == len(set(identifiers)), "duplicate fixture identifier"
    return vectors


def encoded(value: object) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify committed vectors without rewriting files")
    args = parser.parse_args()
    fixture = {"schemaVersion": 1, "profile": PROFILE, "vectors": vector_set()}
    outputs = {
        "protocol-profile.json": encoded(PROFILE),
        "fixtures/protocol-vectors.json": encoded(fixture),
    }
    checksums = "".join(f"{hashlib.sha256(contents).hexdigest()}  {relative}\n"
                        for relative, contents in outputs.items())
    outputs["fixtures/SHA256SUMS"] = checksums.encode("ascii")
    for relative, contents in outputs.items():
        if args.check:
            if (ROOT / relative).read_bytes() != contents:
                raise SystemExit(f"Regeneration mismatch: {relative}")
        else:
            (ROOT / relative).write_bytes(contents)
    print(f"{'Verified' if args.check else 'Generated'} {len(fixture['vectors'])} synthetic/source-derived vectors.")
    print(checksums, end="")


if __name__ == "__main__":
    main()
