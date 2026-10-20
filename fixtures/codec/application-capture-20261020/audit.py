"""Offline bounded forensic audit and codec-driver operation generator for the retained 7d corpus.

Imports no plugin/codec and launches no child, socket or service. Writes only a new output directory.
Usage: python -B audit.py EXTRACTED_PUBLIC_ROOT NEW_OUTPUT_DIRECTORY
"""
import argparse
import collections
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct

PROFILE = 'wire-sysio-7dede884-engineering-v1'
REVISION = '7dede884e0150d36fa788e85a119e10653ade8ca'
CHAIN = '9f70136446c1a3ea95deefbbe4aaeee4f31f16870eba976fcb7054172fbffacf'
ARCHIVE_SHA = '9a0b82e070662be562b2da3d4db61f1f7e143f1b32df47fef7a831b120077026'
EXPORT_SHA = '139206ce71eac98e817cb32fc34442bac9ede94a8ea50156f1ba3d5f9afa105c'
CAPTURE = 'evidence/capture-application-2-120-final/'
STREAM_ORDER = ['account', 'account_metadata', 'code', 'contract_row_kv', 'contract_index_kv',
                'global_property', 'protocol_state', 'permission', 'permission_link',
                'resource_limits', 'resource_usage', 'resource_limits_state', 'resource_limits_config']
MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
MAX_ITEMS = 10000
MAX_OUTPUT = 128 * 1024 * 1024


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate JSON key: ' + key); result[key] = value
        return result
    def invalid(value):
        raise ValueError('nonfinite JSON: ' + value)
    return json.loads(data, object_pairs_hook=pairs, parse_constant=invalid)


def ordinary(path, directory=False):
    path = Path(os.path.abspath(path))
    for item in [*reversed(path.parents), path]:
        value = item.lstat()
        require(not stat.S_ISLNK(value.st_mode) and not getattr(value, 'st_file_attributes', 0) & 0x400,
                'input/output reparse point refused: ' + str(item))
    mode = path.lstat().st_mode
    require(stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode), 'ordinary input/output required')
    return path


def safe_relative(value):
    require(isinstance(value, str) and len(value) <= 512 and '\\' not in value,
            'invalid evidence relative path')
    path = PurePosixPath(value)
    require(not path.is_absolute() and value == str(path) and all(p not in ('', '.', '..') for p in path.parts),
            'evidence path traversal or alias refused')
    return value


class Evidence:
    def __init__(self, root):
        self.root = ordinary(root, True); self.cache = {}; self.total = 0
        manifest = self.read('public-export-manifest.json', listed=False)
        require(sha(manifest) == EXPORT_SHA, 'unexpected public export manifest SHA')
        self.manifest = strict_json(manifest)
        require(self.manifest['chainId'] == CHAIN and self.manifest['privateValuesIncluded'] is False,
                'unexpected export identity or privacy declaration')
        entries = self.manifest['files']; require(len(entries) == self.manifest['fileCount'] == 3753, 'wrong export membership')
        self.files = {}
        for entry in entries:
            name = safe_relative(entry['path']); require(name not in self.files, 'duplicate export member')
            require(type(entry['bytes']) is int and 0 <= entry['bytes'] <= MAX_FILE
                    and re.fullmatch('[0-9a-f]{64}', entry['sha256']), 'invalid export entry')
            self.files[name] = entry
        for name in self.files:
            self.read(name)
        require(sum(row['bytes'] for row in entries) == self.manifest['totalBytes'] == 12148075,
                'public export byte membership differs')

    def read(self, name, listed=True):
        name = safe_relative(name)
        if name in self.cache:
            return self.cache[name]
        require(len(self.cache) < 5000, 'evidence file-count bound exceeded')
        path = ordinary(self.root / name); require(path.stat().st_size <= MAX_FILE, 'evidence file too large')
        with path.open('rb') as stream:
            data = stream.read(MAX_FILE + 1)
        require(len(data) <= MAX_FILE, 'evidence read exceeded bound')
        self.total += len(data); require(self.total <= MAX_TOTAL, 'evidence total byte bound exceeded')
        if listed:
            entry = self.files[name]
            require(len(data) == entry['bytes'] and sha(data) == entry['sha256'], 'evidence hash mismatch: ' + name)
        self.cache[name] = data
        return data

    def json(self, name):
        return strict_json(self.read(name))


class Reader:
    """Independent canonical byte cursor; no code from the implementation under qualification."""
    def __init__(self, data):
        require(isinstance(data, bytes) and len(data) <= MAX_FILE, 'raw input byte bound exceeded')
        self.data, self.offset, self.nodes = data, 0, 0

    def take(self, size):
        require(type(size) is int and 0 <= size <= len(self.data) - self.offset, 'truncated raw source')
        result = self.data[self.offset:self.offset + size]; self.offset += size
        return result

    def uint(self, size, signed=False):
        return int.from_bytes(self.take(size), 'little', signed=signed)

    def varuint(self):
        value = 0
        for index in range(5):
            byte = self.uint(1); require(index < 4 or byte < 16, 'varuint32 overflow')
            value |= (byte & 127) << (index * 7)
            if not byte & 128:
                require(index == 0 or byte != 0, 'noncanonical varuint32')
                return value
        raise ValueError('unterminated varuint32')

    def count(self):
        value = self.varuint(); require(value <= MAX_ITEMS, 'raw collection bound exceeded'); return value

    def blob(self):
        return self.take(self.varuint())

    def text(self):
        return self.blob().decode('utf-8', errors='strict')

    def end(self):
        require(self.offset == len(self.data), 'unconsumed physical bytes')


def name_from_uint(value):
    alphabet = '.12345abcdefghijklmnopqrstuvwxyz'; chars = []
    for index in range(13):
        bits = 4 if index == 0 else 5; chars.append(alphabet[value & ((1 << bits) - 1)]); value >>= bits
    return ''.join(reversed(chars)).rstrip('.')


def decode_schema(reader, type_name, abi, depth=0):
    """Strict small forensic subset for actual envelope/traces, not a replacement ABI/value codec."""
    reader.nodes += 1; require(reader.nodes <= 200000 and depth <= 64, 'raw source traversal bound')
    child = lambda name: decode_schema(reader, name, abi, depth + 1)
    if type_name.endswith('?'):
        flag = reader.uint(1); require(flag in (0, 1), 'invalid source optional flag')
        return child(type_name[:-1]) if flag else None
    if type_name.endswith('[]'):
        return [child(type_name[:-2]) for _ in range(reader.count())]
    if type_name == 'bytes': return reader.blob().hex()
    if type_name == 'string': return reader.text()
    if type_name == 'name': return name_from_uint(reader.uint(8))
    if type_name == 'checksum256': return reader.take(32).hex()
    if type_name == 'bool':
        flag = reader.uint(1); require(flag in (0, 1), 'nonbinary source bool'); return flag
    if type_name == 'varuint32': return reader.varuint()
    scalar = re.fullmatch('(u?int)(8|16|32|64|128)', type_name)
    if scalar:
        bits = int(scalar[2]); value = reader.uint(bits // 8, scalar[1] == 'int')
        return str(value) if bits >= 64 else value
    if type_name == 'time_point_sec':
        return datetime.datetime.fromtimestamp(reader.uint(4), datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
    if type_name == 'block_timestamp_type':
        value = datetime.datetime(2025, 1, 1) + datetime.timedelta(milliseconds=reader.uint(4) * 500)
        return value.isoformat(timespec='milliseconds')
    if type_name == 'signature':
        # Actual source partial transactions use K1. Preserve its exact carrier; do not invent base58 equivalence.
        kind = reader.varuint(); require(kind == 0, 'forensic trace signature profile not K1')
        return {'opaqueK1SignatureHex': reader.take(65).hex()}
    alias = next((row for row in abi.get('types', []) if row['new_type_name'] == type_name), None)
    if alias: return child(alias['type'])
    variant = next((row for row in abi.get('variants', []) if row['name'] == type_name), None)
    if variant:
        index = reader.varuint(); require(index < len(variant['types']), 'unknown raw source variant')
        selected = variant['types'][index]; return [selected, child(selected)]
    definition = next((row for row in abi['structs'] if row['name'] == type_name), None)
    require(definition is not None, 'unsupported forensic source type: ' + type_name)
    value = child(definition['base']) if definition.get('base') else {}
    for field in definition['fields']: value[field['name']] = child(field['type'])
    return value


def decode_complete(data, type_name, abi):
    reader = Reader(data); value = decode_schema(reader, type_name, abi); reader.end(); return value


def physical_deltas(data):
    reader = Reader(data); declared = reader.count(); deltas, rows, previous = [], [], -1
    while reader.offset < len(data):
        require(len(deltas) < len(STREAM_ORDER), 'too many physical delta streams')
        start = reader.offset; require(reader.varuint() == 0, 'unsupported physical table_delta variant')
        name = reader.text(); require(name in STREAM_ORDER, 'unknown physical delta stream')
        order = STREAM_ORDER.index(name); require(order > previous, 'duplicate/unordered physical delta stream'); previous = order
        items = []
        for ordinal in range(reader.count()):
            require(len(rows) < MAX_ITEMS, 'physical row-count bound exceeded')
            present = reader.uint(1); require(present in (0, 1), 'invalid physical presence flag')
            length = reader.varuint(); offset = reader.offset; raw = reader.take(length)
            item = {'present': present, 'data': raw.hex()}; items.append(item)
            rows.append({'stream': name, 'streamOrdinal': len(deltas), 'rowOrdinal': ordinal,
                         'deltaOrdinal': len(rows), 'present': bool(present), 'offset': offset,
                         'bytes': length, 'sha256': sha(raw), 'rawHex': raw.hex()})
        deltas.append(['table_delta_v0', {'name': name, 'rows': items}])
    reader.end(); actual = len(deltas); names = [row[1]['name'] for row in deltas]
    corrected = actual != declared
    require(not corrected or actual == declared + 1 and 'resource_limits' in names and 'resource_usage' in names,
            'physical membership differs from the exact pinned count-defect shape')
    return deltas, rows, {'declaredCount': declared, 'actualCount': actual,
                          'compatibility': 'wire-resource-index-count-v1' if corrected else None}


def physical_row(row):
    reader = Reader(bytes.fromhex(row['rawHex'])); require(reader.varuint() == 0, 'unsupported physical row version')
    if row['stream'] == 'account':
        name = name_from_uint(reader.uint(8)); slot = reader.uint(4); abi = reader.blob(); reader.end()
        time = datetime.datetime(2025, 1, 1) + datetime.timedelta(milliseconds=slot * 500)
        return ['account_v0', {'name': name, 'creation_date': time.isoformat(timespec='milliseconds'), 'abi': abi.hex()}]
    if row['stream'] in ('contract_row_kv', 'contract_index_kv'):
        value = {'code': name_from_uint(reader.uint(8)), 'payer': name_from_uint(reader.uint(8)), 'table_id': reader.uint(2)}
        for key in (['key', 'value'] if row['stream'] == 'contract_row_kv' else ['sec_key', 'pri_key']): value[key] = reader.blob().hex()
        reader.end(); return [row['stream'] + '_v0', value]
    return None


def normalize_source_oracle(value):
    # Only raw source integer carriers are normalized; named application fields use ABI-directed normalization later.
    if isinstance(value, list): return [normalize_source_oracle(item) for item in value]
    if isinstance(value, dict):
        return {key: (str(item) if type(item) is int and key in
                      ('elapsed', 'net_usage', 'global_sequence', 'recv_sequence', 'sequence', 'delta', 'error_code')
                      else normalize_source_oracle(item)) for key, item in value.items() if key != 'partial'}
    return value


def normalize_contract_oracle(value, type_name, abi, depth=0):
    require(depth <= 64, 'contract oracle normalization depth exceeded')
    child = lambda item, name: normalize_contract_oracle(item, name, abi, depth + 1)
    if type_name.startswith('protobuf::'): return value
    if type_name.endswith('?'): return None if value is None else child(value, type_name[:-1])
    if type_name.endswith('[]'): return [child(item, type_name[:-2]) for item in value]
    if type_name in ('uint64', 'int64', 'uint128', 'int128', 'varint_int64', 'varint_uint64'): return str(value)
    if type_name == 'bool': return int(value)
    alias = next((row for row in abi.get('types', []) if row['new_type_name'] == type_name), None)
    if alias: return child(value, alias['type'])
    definition = next((row for row in abi.get('structs', []) if row['name'] == type_name), None)
    if definition:
        result = child(value, definition['base']) if definition.get('base') else {}
        for field in definition['fields']:
            if field['name'] in value: result[field['name']] = child(value[field['name']], field['type'])
        return result
    return value


def kv_identity(stream, decoded):
    require(stream in ('contract_row_kv', 'contract_index_kv'), 'unknown KV identity stream')
    return (stream, decoded['code'], decoded['table_id'], decoded['key']) if stream == 'contract_row_kv' else \
        (stream, decoded['code'], decoded['table_id'], decoded['sec_key'], decoded['pri_key'])


def native_abi_metadata(data):
    """Read abi_def.hpp's exact reflected fields, preserving optional tail presence and JSON text.

    Primary layout: Wire revision 7dede884 libraries/chain/include/sysio/chain/abi_def.hpp:196-204.
    This forensic cursor imports no Node/Rust ABI implementation and never uses its decode output.
    """
    reader = Reader(data)
    vector = lambda visit: [visit() for _ in range(reader.count())]
    strings = lambda: vector(reader.text)
    name = lambda: name_from_uint(reader.uint(8))
    fields = lambda: vector(lambda: {'name': reader.text(), 'type': reader.text()})
    table = lambda: {'name': reader.text(), 'index_type': reader.text(), 'key_names': strings(),
                     'key_types': strings(), 'type': reader.text(), 'table_id': reader.uint(2),
                     'secondary_indexes': vector(lambda: {'name': reader.text(), 'key_type': reader.text(), 'table_id': reader.uint(2)})}
    result = {'version': reader.text(),
              'types': vector(lambda: {'new_type_name': reader.text(), 'type': reader.text()}),
              'structs': vector(lambda: {'name': reader.text(), 'base': reader.text(), 'fields': fields()}),
              'actions': vector(lambda: {'name': name(), 'type': reader.text(), 'ricardian_contract': reader.text()}),
              'tables': vector(table),
              'ricardian_clauses': vector(lambda: {'id': reader.text(), 'body': reader.text()}),
              'error_messages': vector(lambda: {'error_code': str(reader.uint(8)), 'error_msg': reader.text()}),
              'abi_extensions': vector(lambda: [reader.uint(2), reader.blob().hex()])}
    tails = [('variants', lambda: vector(lambda: {'name': reader.text(), 'types': strings()})),
             ('action_results', lambda: vector(lambda: {'name': name(), 'result_type': reader.text()})),
             ('enums', lambda: vector(lambda: {'name': reader.text(), 'type': reader.text(),
                                             'values': vector(lambda: {'name': reader.text(), 'value': str(reader.uint(8, True))})})),
             ('protobuf_types', reader.text)]
    for key, read in tails:
        if reader.offset < len(data): result[key] = read()
    reader.end(); require(re.fullmatch(r'sysio::abi/1\.[0-3]', result['version']), 'unsupported native ABI metadata version')
    return result


def semantic_abi(value):
    # These are only documented semantic defaults, never a serialization recipe for captured bytes.
    result = {key: item for key, item in value.items() if key != '____comment'}
    for key in ('types', 'structs', 'actions', 'tables', 'ricardian_clauses', 'error_messages', 'abi_extensions',
                'variants', 'action_results', 'enums'): result.setdefault(key, [])
    result['tables'] = [{**table, 'secondary_indexes': table.get('secondary_indexes', [])} for table in result['tables']]
    result['error_messages'] = [{**entry, 'error_code': str(entry['error_code'])} for entry in result['error_messages']]
    result['enums'] = [{**entry, 'values': [{**member, 'value': str(member['value'])} for member in entry['values']]} for entry in result['enums']]
    if result.get('protobuf_types', '') == '': result.pop('protobuf_types', None)
    elif isinstance(result['protobuf_types'], str): result['protobuf_types'] = strict_json(result['protobuf_types'])
    return result


def trace_membership(raw, oracle, abi):
    traces = decode_complete(raw, 'transaction_trace[]', abi)
    require(normalize_source_oracle(traces) == normalize_source_oracle(oracle), 'physical trace metadata differs from official oracle')
    for variant in traces:
        require(variant[0] == 'transaction_trace_v0', 'unsupported transaction variant')
        value = variant[1]
        require(value['status'] == 0 and value['scheduled'] == 0 and value['failed_dtrx_trace'] is None
                and value['except'] is None and value['error_code'] is None, 'unsupported committed transaction semantics')
        occurrences = {}
        for action_variant in value['action_traces']:
            action = action_variant[1]; receipt = action['receipt']; require(receipt is not None, 'missing action receipt')
            require(receipt[0] == 'action_receipt_v0' and action['receiver'] == receipt[1]['receiver'], 'action receipt mismatch')
            ordinal = action['action_ordinal']; require(ordinal > 0 and ordinal not in occurrences, 'duplicate action ordinal')
            require(action['except'] is None and action['error_code'] is None and int(receipt[1]['global_sequence']) > 0,
                    'failed or unsequenced action')
            occurrences[ordinal] = action
        for action in occurrences.values():
            current, seen = action, set()
            while current['receiver'] != current['act']['account']:
                ordinal = current['action_ordinal']; require(ordinal not in seen and len(seen) < 64, 'cyclic/deep notification ancestry'); seen.add(ordinal)
                parent = occurrences.get(current['creator_action_ordinal'])
                require(parent is not None and parent['act'] == current['act'] and parent['context_free'] == current['context_free'], 'notification origin mismatch')
                require(int(parent['receipt'][1]['global_sequence']) < int(current['receipt'][1]['global_sequence']), 'unordered notification origin')
                current = parent
            action['inputActionOrdinal'] = current['action_ordinal']
            if action['creator_action_ordinal']:
                parent = occurrences.get(action['creator_action_ordinal'])
                require(parent is not None and int(parent['receipt'][1]['global_sequence']) < int(action['receipt'][1]['global_sequence']), 'invalid raw creator ancestry')
    return traces


class Operations:
    def __init__(self): self.operations, self.checks = [], []

    def add(self, identifier, operation, anchor, expected=None, normalization='exact'):
        require(len(self.operations) < MAX_ITEMS, 'codec operation bound exceeded')
        self.checks.append({'index': len(self.operations), 'id': identifier, 'source': anchor,
                            'normalization': normalization if expected is not None else 'parity-only',
                            **({'expected': expected} if expected is not None else {})})
        self.operations.append({'profileId': PROFILE, **operation})


def generate(root, evidence=None):
    evidence = Evidence(root) if evidence is None else evidence
    manifest = evidence.json(CAPTURE + 'manifest.json'); abi = evidence.json(CAPTURE + 'schema.bin')
    require(manifest['status'] == 'captured' and manifest['profileId'] == PROFILE and manifest['pins']['chainId'] == CHAIN
            and manifest['pins']['node']['sourceRevision'] == REVISION and manifest['range'] ==
            {'startBlock': 2, 'endBlockInclusive': 120, 'complete': True}, 'wrong final raw capture')
    require(sha(evidence.read(CAPTURE + 'schema.bin')) == manifest['pins']['handshakeSha256'], 'SHiP schema digest mismatch')
    for entry in manifest['files']:
        raw = evidence.read(CAPTURE + entry['file']); require(len(raw) == entry['bytes'] and sha(raw) == entry['sha256'], 'inner capture membership mismatch')
    require(len(manifest['blocks']) == 119 and manifest['oracleExclusions'] == [], 'final capture membership incomplete')
    ops = Operations(); block_audits, transactions, actions, kv_rows, deployments, accounts, framing = [], {}, [], [], [], [], collections.Counter()
    raw_rows = []; global_sequences = set(); previous = manifest['initialAncestry']['firstPreviousPosition']
    artifact_abis = {}
    for name in ('test_kv_map', 'test_kv_sec_query', 'proto_abi_test', 'action_order_test'):
        artifact_abis[name] = evidence.json('artifacts/' + name + '.abi')
    plans = {}; packed = {}; artifact_manifest = evidence.json('artifacts/manifest.json')
    require(artifact_manifest['sourceRevision'] == REVISION, 'artifact manifest source revision mismatch')
    for artifact in artifact_manifest['files']:
        raw = evidence.read('artifacts/' + artifact['path'])
        require(len(raw) == artifact['bytes'] and sha(raw) == artifact['sha256']
                and hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == artifact['gitBlob'],
                'upstream artifact SHA or Git-blob identity mismatch')
    packed_hashes = evidence.json('evidence/workload-plans/packed-abi-hashes.json')
    abi_by_hash = {row['sha256']: artifact_abis[name] for name, row in packed_hashes.items()}
    for stage in ('bootstrap', 'deployment', 'applications'):
        plan = evidence.json('evidence/workload-plans/' + stage + '.json')
        require(plan['chainId'] == CHAIN and plan['sourceRevision'] == REVISION
                and plan['artifactManifestSha256'] == sha(evidence.read('artifacts/manifest.json')), 'plan identity mismatch')
        plans[stage] = plan
        for operation in plan['operations']:
            for action in operation['actions']:
                if action['account'] == 'sysio' and action['name'] == 'setabi':
                    body = bytes.fromhex(action['data']['abi']); require(sha(body) in abi_by_hash, 'unrecognized planned packed ABI')
                    require(any(row['sha256'] == sha(body) and row['bytes'] == len(body) for row in packed_hashes.values()), 'packed ABI hash/length mismatch')
                    packed[action['data']['abi']] = abi_by_hash[sha(body)]
    active = {}; application_actions = []; duplicate_inputs = []; row_state = {}; kv_events = []
    for ordinal, block in enumerate(manifest['blocks']):
        number = ordinal + 2; require(block['blockNum'] == number and block['ordinal'] == ordinal and block['previousPosition'] == previous, 'noncontiguous captured range')
        prefix = CAPTURE + 'blocks/%05d' % ordinal; anchor = {'blockNum': number, 'resultFile': prefix + '-result.bin'}
        raw_envelope = evidence.read(prefix + '-result.bin'); envelope = decode_complete(raw_envelope, 'result', abi)
        oracle_envelope = evidence.json(prefix + '-result-oracle.json'); require(envelope == oracle_envelope, 'raw result differs from official envelope')
        value = envelope[1]; require(value['this_block'] == {'block_num': number, 'block_id': block['blockId']}
                                   and value['last_irreversible']['block_num'] >= 120, 'wrong source or irreversible identity')
        require(value['prev_block'] == {'block_num': previous[0], 'block_id': previous[1]}, 'raw parent link mismatch')
        previous = [number, block['blockId']]
        for field in ('block', 'traces', 'deltas'):
            require(bytes.fromhex(value[field]) == evidence.read(prefix + '-' + field + '.bin'), 'outer/nested raw byte mismatch')
        ops.add('block-%d-result' % number, {'operation': 'decodeValue', 'abi': abi, 'typeName': 'result', 'hex': raw_envelope.hex()}, anchor, {'result': oracle_envelope}, 'official-oracle')
        signed = evidence.json(prefix + '-block-oracle.json'); require(signed['previous'] == value['prev_block']['block_id'], 'signed-block parent mismatch')
        packed_transaction_ids = []
        for transaction in signed['transactions']:
            packed_transaction = transaction['trx']
            require(packed_transaction['compression'] == 0, 'unsupported compressed packed transaction in actual corpus')
            packed_transaction_ids.append(sha(bytes.fromhex(packed_transaction['packed_trx'])))
        ops.add('block-%d-signed' % number, {'operation': 'decodeValue', 'abi': abi, 'typeName': 'signed_block', 'hex': value['block']}, anchor, {'result': signed}, 'official-oracle')
        oracle_traces = evidence.json(prefix + '-traces-oracle.json'); traces = trace_membership(bytes.fromhex(value['traces']), oracle_traces, abi)
        user_trace_ids = [trace[1]['id'] for trace in traces if not all(action[1]['act']['account'] == 'sysio'
                          and action[1]['act']['name'] == 'onblock' for action in trace[1]['action_traces'])]
        require(packed_transaction_ids == user_trace_ids, 'packed signed-block transaction hashes differ from captured source trace membership')
        ops.add('block-%d-traces' % number, {'operation': 'decodeValue', 'abi': abi, 'typeName': 'transaction_trace[]', 'hex': value['traces']}, anchor, {'result': oracle_traces}, 'official-oracle')
        deltas, rows, physical = physical_deltas(bytes.fromhex(value['deltas'])); framing[physical['compatibility'] or 'canonical'] += 1
        official_deltas = evidence.json(prefix + '-deltas-oracle.json')
        require(official_deltas == deltas[:physical['declaredCount']], 'official delta output differs from the physical declared prefix')
        ops.add('block-%d-deltas-compat' % number, {'operation': 'decodeDeltas', 'abi': abi, 'hex': value['deltas']}, anchor, {'result': {'deltas': deltas, 'framing': physical}})
        ops.add('block-%d-deltas-strict' % number, {'operation': 'decodeValue', 'abi': abi, 'typeName': 'table_delta[]', 'hex': value['deltas']}, anchor,
                {'error': 'invalid_value'} if physical['compatibility'] else {'result': deltas})
        by_account = {}
        for row in rows:
            row.update(blockNum=number, sourceFile=prefix + '-deltas.bin')
            parsed = physical_row(row); row['decoded'] = parsed
            row_anchor = {**anchor, 'deltaFile': row['sourceFile'], 'stream': row['stream'], 'offset': row['offset'], 'bytes': row['bytes'], 'sha256': row['sha256']}
            ops.add('block-%d-row-%d' % (number, row['deltaOrdinal']), {'operation': 'decodeValue', 'abi': abi, 'typeName': row['stream'], 'hex': row['rawHex']}, row_anchor,
                    {'result': parsed} if parsed is not None else None)
            if row['stream'] == 'account':
                by_account[parsed[1]['name']] = row; accounts.append(row)
            elif row['stream'] in ('contract_row_kv', 'contract_index_kv'): kv_rows.append(row)
            raw_rows.append(row)
        for trace in traces:
            transaction = trace[1]; transaction_id = transaction['id']; require(transaction_id not in transactions, 'duplicate raw transaction ID')
            transactions[transaction_id] = {'blockNum': number, 'sourceFile': prefix + '-traces.bin', 'trace': transaction}
            first_receivers = collections.defaultdict(list)
            for trace_action in sorted(transaction['action_traces'], key=lambda a: int(a[1]['receipt'][1]['global_sequence'])):
                action = trace_action[1]; receipt = action['receipt'][1]; sequence = receipt['global_sequence']
                require(sequence not in global_sequences, 'duplicate raw global sequence'); global_sequences.add(sequence)
                record = {'blockNum': number, 'transactionId': transaction_id, 'sourceFile': prefix + '-traces.bin',
                          'actionOrdinal': action['action_ordinal'], 'creatorActionOrdinal': action['creator_action_ordinal'],
                          'inputActionOrdinal': action['inputActionOrdinal'], 'receiver': action['receiver'],
                          'account': action['act']['account'], 'name': action['act']['name'], 'rawHex': action['act']['data'],
                          'globalSequence': sequence, 'receiptAbiSequence': receipt['abi_sequence'], 'returnHex': action.get('return_value', '')}
                actions.append(record)
                if record['receiver'] == record['account']: first_receivers[(record['account'], record['name'], record['rawHex'])].append(record)
                if record['receiver'] == record['account'] == 'sysio' and record['name'] == 'setabi':
                    reader = Reader(bytes.fromhex(record['rawHex'])); account = name_from_uint(reader.uint(8)); body = reader.blob(); reader.end()
                    require(body.hex() in packed, 'unplanned/missing packed ABI deployment'); contract_abi = packed[body.hex()]
                    native_metadata = native_abi_metadata(body)
                    require(semantic_abi(native_metadata) == semantic_abi(contract_abi), 'native packed ABI differs semantically from committed ABI artifact')
                    final = by_account.get(account); require(final is not None and final['present'] and final['decoded'][1]['abi'] == body.hex(), 'setabi differs from physical account final state')
                    episode = {**record, 'target': account, 'abiSha256': sha(body), 'abiBytes': len(body), 'abiHex': body.hex(),
                               'accountDeltaFile': final['sourceFile'], 'accountDeltaOffset': final['offset'], 'effect': 'native-before-receipt',
                               'observedDeploymentOrdinal': sum(d['target'] == account for d in deployments) + 1}
                    deployments.append(episode); active[account] = (episode, contract_abi)
                    ops.add('abi-deployment-' + account + '-' + sequence, {'operation': 'decodeAbi', 'hex': body.hex()}, record, {'result': native_metadata})
                    ops.add('abi-reencode-' + account + '-' + sequence, {'operation': 'encodeAbi', 'abi': native_metadata}, record, {'result': body.hex()})
                selected = active.get(record['account'])
                if selected and record['receiver'] == record['account']:
                    episode, contract_abi = selected; action_type = next((a['type'] for a in contract_abi['actions'] if a['name'] == record['name']), None)
                    require(action_type is not None, 'actual action absent from captured ABI episode')
                    require(record['receiptAbiSequence'] == episode['observedDeploymentOrdinal'], 'application receipt ABI epoch differs from observed new-account deployment history')
                    app = {**record, 'abiDeploymentSequence': episode['globalSequence'], 'abiSha256': episode['abiSha256'], 'typeName': action_type}
                    application_actions.append(app)
                    ops.add('action-' + sequence, {'operation': 'decodeValue', 'abi': contract_abi, 'typeName': action_type, 'hex': record['rawHex']}, app)
                    if record['returnHex']:
                        result_type = next((r['result_type'] for r in contract_abi.get('action_results', []) if r['name'] == record['name']), None)
                        require(result_type is not None, 'untyped actual action return')
                        ops.add('return-' + sequence, {'operation': 'decodeValue', 'abi': contract_abi, 'typeName': result_type, 'hex': record['returnHex']}, app)
            for group in first_receivers.values():
                if len(group) > 1: duplicate_inputs.append(group)
        for row in rows:
            if row['stream'] not in ('contract_row_kv', 'contract_index_kv'): continue
            decoded = row['decoded'][1]; selected = active.get(decoded['code'])
            identity = kv_identity(row['stream'], decoded); prior = row_state.get(identity)
            change = 'insert' if row['present'] and prior is None else 'update' if row['present'] else 'delete'
            event = {**row, 'change': change, 'priorSeen': prior is not None}; kv_events.append(event)
            if row['present']: row_state[identity] = decoded
            else: row_state.pop(identity, None)
            if selected and row['stream'] == 'contract_row_kv' and row['present']:
                episode, contract_abi = selected; table = next((t for t in contract_abi.get('tables', []) if t.get('table_id') == decoded['table_id']), None)
                require(table is not None, 'actual physical KV table lacks captured ABI numeric ID')
                ops.add('kv-value-%d-%d' % (number, row['deltaOrdinal']), {'operation': 'decodeValue', 'abi': contract_abi, 'typeName': table['type'], 'hex': decoded['value']},
                        {**row, 'abiSha256': episode['abiSha256'], 'abiDeploymentSequence': episode['globalSequence']},
                        {'result': decode_complete(bytes.fromhex(decoded['value']), table['type'], contract_abi)})
        block_audits.append({'blockNum': number, 'blockId': block['blockId'], 'sourceFile': prefix + '-result.bin',
                             'traceTransactions': len(traces), 'deltaFraming': physical,
                             'streams': [{'name': delta[1]['name'], 'rows': len(delta[1]['rows'])} for delta in deltas],
                             'officialTrailingStreamsOmitted': len(deltas) - len(official_deltas)})
    stage_membership = []; checks_by_id = {check['id']: check for check in ops.checks}
    for stage, plan in plans.items():
        summary = evidence.json('evidence/application-' + stage + '-run/summary.json')
        require(summary['status'] == 'passed' and summary['chainId'] == CHAIN and len(summary['operations']) == len(plan['operations']), 'incomplete stage summary')
        for index, planned in enumerate(plan['operations']):
            recorded = summary['operations'][index]; require(recorded['id'] == planned['id'], 'stage operation mismatch')
            prefix = 'evidence/application-' + stage + '-run/%03d-%s' % (index + 1, planned['id'])
            receipt = evidence.json(prefix + '-receipt.json'); raw_receipt = evidence.read(prefix + '-receipt.json')
            require(sha(raw_receipt) == recorded['receiptSha256'] and receipt['transaction_id'] == recorded['transactionId'], 'receipt identity/hash mismatch')
            actual = transactions[recorded['transactionId']]; require(actual['blockNum'] == recorded['blockNum'], 'planned transaction absent from captured block')
            irreversible = evidence.json(prefix + '-irreversible.json'); canonical = evidence.json(prefix + '-canonical-block.json')
            require(irreversible['chain_id'] == CHAIN and irreversible['last_irreversible_block_num'] >= recorded['blockNum']
                    and canonical['id'] == recorded['blockId'] == block_audits[recorded['blockNum'] - 2]['blockId'], 'recorded irreversible/canonical block mismatch')
            require(any(transaction['trx']['id'] == recorded['transactionId']
                        and sha(bytes.fromhex(transaction['trx']['packed_trx'])) == recorded['transactionId']
                        for transaction in canonical['transactions']), 'canonical RPC block lacks the exact planned packed transaction')
            raw_actions = actual['trace']['action_traces']; roots = [a[1] for a in raw_actions if a[1]['creator_action_ordinal'] == 0 and a[1]['receiver'] == a[1]['act']['account']]
            require(len(roots) == len(planned['actions']), 'captured root-action count differs from submitted plan')
            received = {a['action_ordinal']: a for a in receipt['processed']['action_traces']}
            for raw_action in raw_actions:
                action = raw_action[1]; observed = received[action['action_ordinal']]
                require(action['act']['data'] == observed['act']['hex_data'] and action['act']['account'] == observed['act']['account']
                        and action['act']['name'] == observed['act']['name'] and action['receiver'] == observed['receiver']
                        and action['creator_action_ordinal'] == observed['creator_action_ordinal']
                        and action['receipt'][1]['global_sequence'] == str(observed['receipt']['global_sequence']), 'raw source/operation receipt metadata mismatch')
                check = checks_by_id.get('action-' + action['receipt'][1]['global_sequence'])
                if check is not None:
                    operation = ops.operations[check['index']]
                    check['expected'] = {'result': normalize_contract_oracle(observed['act']['data'], operation['typeName'], operation['abi'])}
                    check['normalization'] = 'exact'; check['independentOracleFile'] = prefix + '-receipt.json'
                result_check = checks_by_id.get('return-' + action['receipt'][1]['global_sequence'])
                if result_check is not None:
                    require(action['return_value'] == observed['return_value_hex_data'] and 'return_value_data' in observed,
                            'actual return bytes or official return oracle missing')
                    operation = ops.operations[result_check['index']]
                    result_check['expected'] = {'result': normalize_contract_oracle(observed['return_value_data'], operation['typeName'], operation['abi'])}
                    result_check['normalization'] = 'exact'; result_check['independentOracleFile'] = prefix + '-receipt.json'
            for action, planned_action in zip(roots, planned['actions']):
                require(action['act']['account'] == planned_action['account'] and action['act']['name'] == planned_action['name']
                        and action['act']['authorization'] == planned_action['authorization'], 'raw source/submitted action mismatch')
            stage_membership.append({'stage': stage, **recorded, 'receiptFile': prefix + '-receipt.json', 'traceFile': actual['sourceFile'], 'rootActions': len(roots), 'allReceiptActions': len(raw_actions)})
    audit = {'schemaVersion': 1, 'status': 'audited-raw-membership', 'sourceArchiveSha256': ARCHIVE_SHA,
             'sourceExportManifestSha256': EXPORT_SHA, 'profileId': PROFILE, 'sourceRevision': REVISION, 'chainId': CHAIN,
             'exportFilesVerified': len(evidence.files), 'exportBytesVerified': 12148075, 'range': manifest['range'],
             'blockCount': len(block_audits), 'transactionCount': len(transactions), 'actionReceiptCount': len(actions),
             'physicalDeltaRows': len(raw_rows), 'framingBlockCounts': dict(framing), 'blocks': block_audits,
             'stageMembership': stage_membership, 'abiDeployments': deployments, 'applicationActions': application_actions,
             'duplicateFirstReceiverInputs': duplicate_inputs, 'kvEvents': kv_events,
             'physicalStreamRowCounts': dict(collections.Counter(row['stream'] for row in raw_rows)),
             'kvEventCounts': dict(collections.Counter(row['stream'] + ':' + row['change'] for row in kv_events)),
             'operationCount': len(ops.operations), 'initialAncestry': manifest['initialAncestry'],
             'checkCoverage': dict(collections.Counter(check['normalization'] for check in ops.checks)),
             'limits': ['Raw captured 7d source and source-pinned committed artifacts only; no 6508 capture or selected testnet.',
                        'Starting ancestry/ABI frontier remains unknown; no complete host source authority or history admission claim.',
                        'Official clio delta vectors are only declared prefixes; forensic framing consumes all physical bytes.',
                        'KV insert/update classification is relative to observations within this retained range, not a global state certificate.',
                        'No live plugin/codec/native execution, Node/Rust parity, sink/PIT, reorg, performance or release qualification was performed by this generator.']}
    return ops.operations, ops.checks, audit


def write_new(output, values):
    output = Path(os.path.abspath(output)); ordinary(output.parent, True)
    require(not output.exists() and not output.is_symlink(), 'output must be a new ordinary directory')
    encoded = {name: (json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':')) + '\n').encode() for name, value in values.items()}
    require(sum(len(data) for data in encoded.values()) <= MAX_OUTPUT, 'output byte bound exceeded')
    output.mkdir()
    for name, data in encoded.items():
        with (output / name).open('xb') as stream: stream.write(data); stream.flush(); os.fsync(stream.fileno())
    return {name: {'bytes': len(data), 'sha256': sha(data)} for name, data in encoded.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('root'); parser.add_argument('output'); args = parser.parse_args()
    operations, checks, audit = generate(args.root)
    unoracled = {}
    for operation, check in zip(operations, checks):
        if check['normalization'] != 'parity-only': continue
        key = (operation['typeName'], operation['hex'])
        item = unoracled.setdefault(key, {'typeName': key[0], 'hex': key[1], 'rawSha256': sha(bytes.fromhex(key[1])), 'operationIndexes': [], 'sources': []})
        item['operationIndexes'].append(check['index']); item['sources'].append(check['source'])
    files = write_new(args.output, {'operations.json': operations, 'checks.json': checks, 'audit.json': audit,
                                  'unoracled-rows.json': list(unoracled.values())})
    print(json.dumps({'status': audit['status'], 'operations': len(operations), 'blocks': audit['blockCount'],
                      'transactions': audit['transactionCount'], 'actions': audit['actionReceiptCount'], 'files': files}))


if __name__ == '__main__': main()
