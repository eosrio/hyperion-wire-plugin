"""Resource-free strict forensic cursor/framing/oracle tests; imports no implementation codec."""
import importlib.util
import copy
import gzip
import io
import json
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch

FIXTURE = Path(__file__).resolve().parents[1] / 'fixtures/codec/application-capture-20261020'
SPEC = importlib.util.spec_from_file_location('wire_actual_audit', FIXTURE / 'audit.py')
audit = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(audit)
PREPARE_SPEC = importlib.util.spec_from_file_location('wire_application_prepare', FIXTURE / 'prepare.py')
prepare = importlib.util.module_from_spec(PREPARE_SPEC); PREPARE_SPEC.loader.exec_module(prepare)


def varuint(value):
    result = bytearray()
    while True:
        byte = value & 127; value >>= 7; result.append(byte | (128 if value else 0))
        if not value: return bytes(result)


def text(value):
    body = value.encode(); return varuint(len(body)) + body


def stream(name, rows=()):
    result = b'\0' + text(name) + varuint(len(rows))
    for present, body in rows: result += bytes([present]) + varuint(len(body)) + body
    return result


class ForensicTests(unittest.TestCase):
    def test_varuint_and_byte_cursor_are_canonical_and_bounded(self):
        for value in (0, 1, 127, 128, 16384, 0xffffffff):
            reader = audit.Reader(varuint(value)); self.assertEqual(reader.varuint(), value); reader.end()
        for raw in (b'', b'\x80', b'\x80\0', b'\xff\xff\xff\xff\x10', b'\xff' * 6):
            with self.subTest(raw=raw), self.assertRaises(ValueError): audit.Reader(raw).varuint()
        with self.assertRaises(ValueError): audit.Reader(b'x').take(2)
        with self.assertRaises(ValueError): audit.Reader(b'x').end()

    def test_selected_count_defect_consumes_physical_rows_beyond_official_prefix(self):
        raw = varuint(2) + stream('account') + stream('resource_limits', [(1, b'a')]) + stream('resource_usage', [(0, b'b')])
        deltas, rows, framing = audit.physical_deltas(raw)
        self.assertEqual(framing, {'declaredCount': 2, 'actualCount': 3, 'compatibility': 'wire-resource-index-count-v1'})
        self.assertEqual([row['stream'] for row in rows], ['resource_limits', 'resource_usage'])
        for row in rows: self.assertEqual(raw[row['offset']:row['offset'] + row['bytes']].hex(), row['rawHex'])
        self.assertEqual(deltas[-1][1]['rows'][0], {'present': 0, 'data': '62'})

    def test_canonical_counts_do_not_require_transport_correction(self):
        self.assertEqual(audit.physical_deltas(b'\0')[2], {'declaredCount': 0, 'actualCount': 0, 'compatibility': None})
        self.assertIsNone(audit.physical_deltas(b'\1' + stream('account'))[2]['compatibility'])

    def test_unknown_reordered_duplicate_trailing_and_wrong_count_streams_fail(self):
        raws = [b'\0' + stream('account'), b'\1' + stream('unknown'), b'\2' + stream('account') * 2,
                b'\2' + stream('resource_usage') + stream('resource_limits'),
                b'\1' + stream('account') + b'\xff', b'\0' + stream('resource_limits') + stream('resource_usage'),
                b'\1' + stream('account', [(2, b'a')])]
        for raw in raws:
            with self.subTest(raw=raw), self.assertRaises(ValueError): audit.physical_deltas(raw)

    def test_truncated_physical_delta_inputs_reject(self):
        raw = b'\1' + stream('account', [(1, b'source')])
        for length in range(len(raw)):
            with self.subTest(length=length), self.assertRaises(ValueError): audit.physical_deltas(raw[:length])

    def test_secondary_identity_contains_both_secondary_and_primary_bytes(self):
        first = {'code': 'wiresec', 'table_id': 37799, 'sec_key': 'same-owner', 'pri_key': 'one'}
        second = {**first, 'pri_key': 'two'}
        self.assertNotEqual(audit.kv_identity('contract_index_kv', first), audit.kv_identity('contract_index_kv', second))
        self.assertEqual(audit.kv_identity('contract_index_kv', first)[-2:], ('same-owner', 'one'))

    def test_wide_application_oracle_conversion_uses_declared_abi_types(self):
        abi = {'structs': [{'name': 'put', 'fields': [{'name': 'id', 'type': 'uint64'}, {'name': 'amount', 'type': 'uint64'}, {'name': 'payload', 'type': 'string'}]}]}
        raw = {'id': 18446744073709551615, 'amount': 9007199254740993, 'payload': '18446744073709551615'}
        self.assertEqual(audit.normalize_contract_oracle(raw, 'put', abi), {'id': '18446744073709551615', 'amount': '9007199254740993', 'payload': raw['payload']})
        self.assertEqual(raw['amount'], 9007199254740993)

    def test_raw_forensic_schema_fully_consumes_wide_integer_and_optionals(self):
        abi = {'structs': [], 'variants': []}
        self.assertEqual(audit.decode_complete(struct.pack('<Q', 18446744073709551615), 'uint64', abi), '18446744073709551615')
        self.assertEqual(audit.decode_complete(b'\0', 'uint64?', abi), None)
        for body, typename in [(b'\2', 'uint64?'), (b'\2', 'bool'), (b'\0\0', 'uint64?'), (b'\0', 'uint64')]:
            with self.subTest(body=body, typename=typename), self.assertRaises(ValueError): audit.decode_complete(body, typename, abi)

    def test_relative_paths_refuse_aliases_and_traversal(self):
        self.assertEqual(audit.safe_relative('evidence/blocks/00001.bin'), 'evidence/blocks/00001.bin')
        for value in ('', '../x', '/x', 'a/../x', 'a//x', 'a/./x', 'a\\x', 'a/'):
            with self.subTest(value=value), self.assertRaises(ValueError): audit.safe_relative(value)

    def test_missing_oracles_are_explicit_parity_only_not_successful_goldens(self):
        value = audit.Operations(); value.add('opaque', {'operation': 'decodeValue'}, {'blockNum': 2})
        self.assertEqual(value.checks[0]['normalization'], 'parity-only'); self.assertNotIn('expected', value.checks[0])
        value.add('exact', {'operation': 'decodeValue'}, {'blockNum': 2}, {'result': []})
        self.assertEqual(value.checks[1]['normalization'], 'exact'); self.assertEqual(value.checks[1]['expected'], {'result': []})

    def test_native_abi_preserves_absent_and_present_empty_tail_sections(self):
        mandatory = text('sysio::abi/1.3') + b'\0' * 7
        absent = audit.native_abi_metadata(mandatory); present = audit.native_abi_metadata(mandatory + b'\0' * 4)
        self.assertNotIn('variants', absent); self.assertNotIn('protobuf_types', absent)
        self.assertEqual(present['variants'], []); self.assertEqual(present['protobuf_types'], '')
        self.assertEqual(audit.semantic_abi(absent), audit.semantic_abi(present))
        with self.assertRaises(ValueError): audit.native_abi_metadata(mandatory + b'\0' * 5)

    def test_native_abi_raw_protobuf_string_is_byte_exact_while_semantics_compare_objects(self):
        descriptor = '{ "z": 2, "a": 1 }'
        raw = text('sysio::abi/1.3') + b'\0' * 7 + b'\0' * 3 + text(descriptor)
        decoded = audit.native_abi_metadata(raw); self.assertEqual(decoded['protobuf_types'], descriptor)
        self.assertEqual(audit.semantic_abi(decoded), audit.semantic_abi({**decoded, 'protobuf_types': {'a': 1, 'z': 2}}))

    def test_committed_table_default_is_semantic_only_and_never_mutates_native_metadata(self):
        native = {'version': 'sysio::abi/1.2', 'tables': [{'name': 'geodata', 'secondary_indexes': []}]}
        committed = {'____comment': 'generated', 'version': 'sysio::abi/1.2', 'tables': [{'name': 'geodata'}]}
        self.assertEqual(audit.semantic_abi(native), audit.semantic_abi(committed)); self.assertNotIn('secondary_indexes', committed['tables'][0])


class ArchiveGuardTests(unittest.TestCase):
    def archive(self, entries, directory):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w') as stream:
            for name, body, kind in entries:
                info = tarfile.TarInfo(name); info.type = kind
                if kind == tarfile.REGTYPE: info.size = len(body)
                else: info.linkname = 'target'
                stream.addfile(info, io.BytesIO(body) if kind == tarfile.REGTYPE else None)
        compressed = gzip.compress(raw.getvalue(), mtime=0); path = Path(directory) / 'input.tar.gz'; path.write_bytes(compressed)
        return path, {'sha256': audit.sha(compressed), 'files': len(entries), 'bytes': sum(len(body) for _, body, kind in entries if kind == tarfile.REGTYPE)}

    def test_archive_preflight_reads_regular_members_without_extracting(self):
        with tempfile.TemporaryDirectory() as directory:
            path, expected = self.archive([('evidence/raw.bin', b'abc', tarfile.REGTYPE)], directory)
            self.assertEqual(prepare.archive_payloads(path, expected), {'evidence/raw.bin': b'abc'})
            self.assertEqual([p.name for p in Path(directory).iterdir()], ['input.tar.gz'])

    def test_path_aliases_traversal_and_windows_drive_paths_fail_before_extraction(self):
        for name in ('../escape', '/absolute', 'evidence/../escape', 'a//b', 'a/./b', 'C:/escape', 'a\\b'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                path, expected = self.archive([(name, b'x', tarfile.REGTYPE)], directory)
                with self.assertRaises(ValueError): prepare.archive_payloads(path, expected)
                self.assertEqual(len(list(Path(directory).iterdir())), 1)

    def test_links_devices_and_directories_are_not_followed_or_extracted(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                path, expected = self.archive([('member', b'', kind)], directory)
                with self.assertRaises(ValueError): prepare.archive_payloads(path, expected)

    def test_duplicate_case_alias_and_file_parent_collision_are_refused(self):
        for names in [('a', 'a'), ('A', 'a'), ('a', 'a/b')]:
            with self.subTest(names=names), tempfile.TemporaryDirectory() as directory:
                path, expected = self.archive([(name, b'x', tarfile.REGTYPE) for name in names], directory)
                with self.assertRaises(ValueError): prepare.archive_payloads(path, expected)

    def test_digest_counts_and_decompression_bounds_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path, expected = self.archive([('evidence', b'x' * 100, tarfile.REGTYPE)], directory)
            for field, value in [('sha256', '0' * 64), ('files', 2), ('bytes', 101)]:
                with self.subTest(field=field), self.assertRaises(ValueError): prepare.archive_payloads(path, {**expected, field: value})
            with patch.object(prepare, 'MAX_TAR', 50), self.assertRaises(ValueError): prepare.archive_payloads(path, expected)
            with patch.object(prepare, 'MAX_MEMBERS', 0), self.assertRaises(ValueError): prepare.archive_payloads(path, expected)

    def test_inventory_binds_exact_hashes_and_refuses_extra_members(self):
        payloads = {'raw.bin': b'actual'}
        manifest = {'files': [{'path': 'raw.bin', 'bytes': 6, 'sha256': audit.sha(b'actual')}]}
        payloads['inventory.json'] = json.dumps(manifest).encode(); digest = audit.sha(payloads['inventory.json'])
        self.assertEqual(prepare.validate_inventory(payloads, 'inventory.json', digest, 'path'), manifest)
        for changed in [{**payloads, 'raw.bin': b'wrong!'}, {**payloads, 'unlisted.bin': b'extra'}]:
            with self.assertRaises(ValueError): prepare.validate_inventory(changed, 'inventory.json', digest, 'path')

    def test_bad_archive_preflight_never_creates_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); fixture = root / 'fixture'; fixture.mkdir()
            (fixture / 'manifest.json').write_text(json.dumps(prepare.REGISTRY)); output = root / 'new-output'
            with patch.object(prepare, 'archive_payloads', side_effect=ValueError('invalid archive')), self.assertRaises(ValueError):
                prepare.prepare(fixture, output)
            self.assertFalse(output.exists())


class SupplementalBindingTests(unittest.TestCase):
    def source(self):
        schema, driver, raw = b'original schema', b'public driver', b'original row'
        operations = [{'profileId': audit.PROFILE, 'operation': 'decodeValue', 'typeName': 'account', 'hex': raw.hex()}]
        checks = [{'index': 0, 'id': 'block-2-row-0', 'source': {'stream': 'account'}, 'normalization': 'parity-only'}]
        case = {'id': 'case-0001', 'kind': 'row', 'typeName': 'account', 'hex': raw.hex(), 'sourceOperationIndices': [0]}
        plan = {'schemaVersion': 1, 'sourceArchiveSha256': audit.ARCHIVE_SHA, 'operationsSha256': 'old-planning-candidate', 'cases': [case]}
        values = {'schema.bin': schema, 'capture-driver.py': driver, 'plan.json': json.dumps(plan).encode(),
                  'args.json': json.dumps(['convert', 'unpack_hex', raw.hex(), '--type', 'account', '--abi-file', '/owned/schema.bin']).encode(),
                  'stdout.bin': b'{"sequence":18446744073709551615}', 'stderr.bin': b'',
                  'decoded.json': b'{"sequence":18446744073709551615}'}
        def record(name): return {'file': name, 'bytes': len(values[name]), 'sha256': audit.sha(values[name])}
        manifest = {'schemaVersion': 1, 'status': 'observed', 'sourceArchiveSha256': audit.ARCHIVE_SHA,
                    'clio': {'sourceRevision': audit.REVISION, 'sha256': prepare.CLIO_SHA, 'version': 'v1.0.0'},
                    'schemaSha256': audit.sha(schema), 'planSha256': audit.sha(values['plan.json']), 'driverSha256': audit.sha(driver),
                    'commands': [{'exitCode': 0, 'argumentsFile': record('args.json'), 'stdout': record('stdout.bin'), 'stderr': record('stderr.bin')}],
                    'cases': [{**{k: v for k, v in case.items() if k != 'hex'}, 'inputSha256': audit.sha(raw),
                               'oracleCommandIndex': 0, 'decodedFile': record('decoded.json')}]}
        return operations, checks, values, manifest, schema

    def link(self, values):
        operations, checks, payloads, manifest, schema = values
        with patch.object(prepare, 'SCHEMA_SHA', audit.sha(schema)):
            return prepare.linked_oracles(operations, checks, payloads, manifest, schema)

    def test_actual_type_hex_binding_does_not_trust_old_planning_candidate_hash(self):
        linked = self.link(self.source()); self.assertEqual(linked['rowOperations'], 1)
        self.assertEqual(linked['originalPlanningOperationsSha256'], 'old-planning-candidate')
        self.assertEqual(linked['links'][0]['expected']['sequence'], 18446744073709551615)

    def test_wrong_current_type_hex_index_or_oracle_hash_cannot_be_linked(self):
        for mutate in [lambda v: v[0][0].update(typeName='permission'), lambda v: v[0][0].update(hex='00'),
                       lambda v: v[1][0]['source'].update(stream='permission'),
                       lambda v: v[3]['cases'][0].update(sourceOperationIndices=[1]),
                       lambda v: v[2].update({'decoded.json': b'{"sequence":0}'})]:
            value = self.source(); mutate(value)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.link(value)

    def test_every_parity_only_operation_requires_its_own_official_observation(self):
        value = self.source(); value[0].append(copy.deepcopy(value[0][0]))
        value[1].append({'index': 1, 'id': 'block-2-row-1', 'source': {'stream': 'account'}, 'normalization': 'parity-only'})
        with self.assertRaisesRegex(ValueError, 'lacks'): self.link(value)

    def test_exit_zero_serializer_error_is_not_an_independent_oracle(self):
        value = self.source(); value[2]['stderr.bin'] = b'ERROR: unable to convert'
        value[3]['commands'][0]['stderr'].update(bytes=len(value[2]['stderr.bin']), sha256=audit.sha(value[2]['stderr.bin']))
        with self.assertRaisesRegex(ValueError, 'serializer reported failure'): self.link(value)


if __name__ == '__main__': unittest.main()
