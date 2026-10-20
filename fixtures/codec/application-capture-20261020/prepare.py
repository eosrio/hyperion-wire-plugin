"""Validate both complete retained archives before creating any output; no services or codecs."""
import argparse
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import tarfile

SPEC = importlib.util.spec_from_file_location('application_capture_audit', Path(__file__).with_name('audit.py'))
audit = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(audit)
require, sha, strict_json = audit.require, audit.sha, audit.strict_json
SUPPLEMENT_SHA = '10330576abcef6b2ba4e45c67e479024f18d5ccb3a663cb711b62b51f1663a5d'
SUPPLEMENT_MANIFEST_SHA = 'ce077aa64d4f62721cd1d53cf16f6479bc580902177cfea24c53cf16886488b5'
CLIO_SHA = 'a8298cc96d0265b384aebba178d255ff73917fcae0a0d4abf086f45016efb76a'
SCHEMA_SHA = '94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9'
REGISTRY = {'schemaVersion': 1,
            'rawCapture': {'file': 'raw-capture.tar.gz', 'sha256': audit.ARCHIVE_SHA,
                           'manifestSha256': audit.EXPORT_SHA, 'files': 3754, 'bytes': 12897392},
            'officialRowOracles': {'file': 'official-row-oracles.tar.gz', 'sha256': SUPPLEMENT_SHA,
                                   'manifestSha256': SUPPLEMENT_MANIFEST_SHA, 'files': 1372, 'bytes': 1372136}}
MAX_ARCHIVE = 8 * 1024 * 1024
MAX_TAR = 48 * 1024 * 1024
MAX_MEMBERS = 6000


def relative_path(value):
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_./-]+', value), 'invalid archive path characters')
    return audit.safe_relative(value)


def archive_payloads(path, expected):
    """Bound decompression in memory; reject all links/specials/aliases before any extraction writes."""
    path = audit.ordinary(path); require(path.stat().st_size <= MAX_ARCHIVE, 'compressed archive exceeds bound')
    with path.open('rb') as stream: compressed = stream.read(MAX_ARCHIVE + 1)
    require(len(compressed) <= MAX_ARCHIVE and sha(compressed) == expected['sha256'], 'archive hash or size mismatch')
    with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode='rb') as stream:
        uncompressed = stream.read(MAX_TAR + 1)
    require(len(uncompressed) <= MAX_TAR, 'expanded archive exceeds bound')
    payloads, folded, total, end = {}, set(), 0, 0
    with tarfile.open(fileobj=io.BytesIO(uncompressed), mode='r:') as archive:
        for member in archive:
            require(len(payloads) < MAX_MEMBERS, 'archive member-count bound exceeded')
            name = relative_path(member.name)
            require(member.isfile() and not member.issparse() and not member.linkname,
                    'archive links/directories/special or sparse members refused')
            require(name not in payloads and name.casefold() not in folded, 'duplicate/case-alias archive member')
            require(type(member.size) is int and 0 <= member.size <= audit.MAX_FILE, 'archive member byte bound exceeded')
            total += member.size; require(total <= audit.MAX_TOTAL, 'archive payload total bound exceeded')
            source = archive.extractfile(member); require(source is not None, 'missing regular archive payload')
            with source: data = source.read(member.size + 1)
            require(len(data) == member.size, 'truncated archive member')
            payloads[name] = data; folded.add(name.casefold())
            end = max(end, member.offset_data + ((member.size + 511) // 512) * 512)
    require(not any(uncompressed[end:]), 'nonzero trailing archive bytes refused')
    require(len(payloads) == expected['files'] and total == expected['bytes'], 'archive inventory totals mismatch')
    for name in payloads:
        require(not any('/'.join(name.split('/')[:index]).casefold() in folded for index in range(1, len(name.split('/')))),
                'archive file/parent collision')
    return payloads


def validate_inventory(payloads, manifest_name, manifest_sha, path_key):
    require(manifest_name in payloads and sha(payloads[manifest_name]) == manifest_sha, 'inner manifest SHA mismatch')
    manifest = strict_json(payloads[manifest_name]); entries = manifest['files']
    require(isinstance(entries, list) and len(entries) < MAX_MEMBERS, 'invalid inner manifest inventory')
    listed = {}
    for entry in entries:
        name = relative_path(entry[path_key]); require(name != manifest_name and name not in listed, 'duplicate/self-referential inner inventory')
        require(type(entry['bytes']) is int and 0 <= entry['bytes'] <= audit.MAX_FILE
                and re.fullmatch('[0-9a-f]{64}', entry['sha256']), 'invalid inner inventory record')
        require(name in payloads and len(payloads[name]) == entry['bytes'] and sha(payloads[name]) == entry['sha256'],
                'inner inventory content differs: ' + name)
        listed[name] = entry
    require(set(payloads) == set(listed) | {manifest_name}, 'unlisted or missing archive membership')
    if 'fileCount' in manifest:
        require(len(listed) == manifest['fileCount'] and sum(row['bytes'] for row in listed.values()) == manifest['totalBytes'],
                'inner listed totals differ')
    return manifest


class MemoryEvidence:
    """Already hash-checked original archive bytes, for pre-write source inventory derivation."""
    def __init__(self, payloads, manifest):
        self.payloads = payloads; self.manifest = manifest
        self.files = {entry['path']: entry for entry in manifest['files']}

    def read(self, name): return self.payloads[audit.safe_relative(name)]
    def json(self, name): return strict_json(self.read(name))


def linked_oracles(operations, checks, payloads, manifest, expected_schema):
    """Bind every old supplemental index to current independently derived type and original bytes."""
    require(manifest['schemaVersion'] == 1 and manifest['status'] == 'observed'
            and manifest['sourceArchiveSha256'] == audit.ARCHIVE_SHA, 'wrong supplement identity/status')
    require(manifest['clio']['sourceRevision'] == audit.REVISION and manifest['clio']['sha256'] == CLIO_SHA
            and manifest['clio']['version'] == 'v1.0.0', 'unexpected official serializer pin')
    require(manifest['schemaSha256'] == SCHEMA_SHA == sha(payloads['schema.bin']) == sha(expected_schema), 'supplement schema mismatch')
    require(manifest['planSha256'] == sha(payloads['plan.json']) and manifest['driverSha256'] == sha(payloads['capture-driver.py']),
            'supplement command-plan or capture-driver identity mismatch')
    plan = strict_json(payloads['plan.json'])
    require(plan['schemaVersion'] == 1 and plan['sourceArchiveSha256'] == audit.ARCHIVE_SHA, 'wrong supplemental input source')
    # operationsSha256 is retained provenance for the original planning candidate, not current source authority.
    require(len(operations) == len(checks) <= audit.MAX_ITEMS, 'invalid operation/check inventory')
    cases, commands = manifest['cases'], manifest['commands']
    require(len(cases) == len(commands) == len(plan['cases']) <= 512, 'incomplete supplemental observation inventory')
    observed, links, row_count, abi_count = set(), [], 0, 0
    for case_index, (case, planned) in enumerate(zip(cases, plan['cases'])):
        require(case['id'] == planned['id'] == 'case-%04d' % (case_index + 1)
                and case['kind'] == planned['kind'] and case['typeName'] == planned['typeName'], 'supplement case metadata mismatch')
        require(case['kind'] in ('row', 'abi') and isinstance(planned['hex'], str)
                and re.fullmatch('(?:[0-9a-f]{2})+', planned['hex']), 'invalid supplemental raw input')
        raw = bytes.fromhex(planned['hex']); require(len(raw) <= 60000 and case['inputSha256'] == sha(raw), 'supplement raw input SHA mismatch')
        require(case['sourceOperationIndices'] == planned['sourceOperationIndices'] and case['oracleCommandIndex'] == case_index,
                'supplement operation/command membership differs')
        command = commands[case_index]; require(command['exitCode'] == 0 and command.get('outputComplete', True) is True, 'failed official serializer command')
        def file_record(record):
            name = relative_path(record['file']); data = payloads[name]
            require(len(data) == record['bytes'] and sha(data) == record['sha256'], 'supplement command/file digest mismatch')
            return data
        arguments = strict_json(file_record(command['argumentsFile']))
        require(arguments[:3] == ['convert', 'unpack_hex', planned['hex']], 'official command did not unpack the original input')
        if case['kind'] == 'row':
            require(arguments[3:6] == ['--type', case['typeName'], '--abi-file'] and len(arguments) == 7
                    and Path(arguments[6]).name == 'schema.bin', 'official row command type/schema mismatch')
        else: require(arguments[3:] == [], 'native ABI command has unexpected arguments')
        stdout, stderr = file_record(command['stdout']), file_record(command['stderr'])
        require(not re.search(br'ERROR:|Unable to convert', stderr, re.IGNORECASE), 'official serializer reported failure despite exit zero')
        decoded_bytes = file_record(case['decodedFile']); expected = strict_json(decoded_bytes)
        require(expected == strict_json(stdout), 'retained official decoded value differs from exact stdout')
        require(isinstance(case['sourceOperationIndices'], list) and case['sourceOperationIndices'], 'empty supplemental source membership')
        for index in case['sourceOperationIndices']:
            require(type(index) is int and 0 <= index < len(operations) and index not in observed, 'duplicate/invalid supplemental operation index')
            operation, check = operations[index], checks[index]
            require(check['index'] == index and operation['profileId'] == audit.PROFILE and operation.get('hex') == planned['hex']
                    and sha(bytes.fromhex(operation['hex'])) == case['inputSha256'], 'supplement index no longer matches original bytes')
            if case['kind'] == 'row':
                require(operation['operation'] == 'decodeValue' and operation['typeName'] == case['typeName']
                        and check['source'].get('stream') == case['typeName'] and re.fullmatch(r'block-\d+-row-\d+', check['id']),
                        'supplement row index no longer matches its current physical type')
                row_count += 1
            else:
                require(operation['operation'] == 'decodeAbi' and case['typeName'] is None and check['id'].startswith('abi-deployment-'),
                        'supplement ABI index no longer names native ABI decode')
                abi_count += 1
            observed.add(index)
            links.append({'index': index, 'kind': case['kind'], 'typeName': case['typeName'], 'caseId': case['id'],
                          'rawSha256': case['inputSha256'], 'decodedFile': case['decodedFile'], 'expected': expected})
    expected_rows = {index for index, check in enumerate(checks) if re.fullmatch(r'block-\d+-row-\d+', check['id'])}
    expected_abis = {index for index, check in enumerate(checks) if check['id'].startswith('abi-deployment-')}
    require(observed == expected_rows | expected_abis, 'official supplement lacks a physical row or native ABI observation')
    require(all('expected' in check or index in observed for index, check in enumerate(checks)), 'an operation has parity without an independent oracle')
    return {'schemaVersion': 1, 'sourceArchiveSha256': audit.ARCHIVE_SHA, 'supplementArchiveSha256': SUPPLEMENT_SHA,
            'supplementManifestSha256': SUPPLEMENT_MANIFEST_SHA, 'originalPlanningOperationsSha256': plan['operationsSha256'],
            'officialCommands': len(cases), 'rowOperations': row_count, 'abiOperations': abi_count, 'links': links}


def extract_new(path, payloads):
    path.mkdir(); audit.ordinary(path, True)
    for name, data in payloads.items():
        target = path
        for part in relative_path(name).split('/')[:-1]:
            target /= part
            if not target.exists(): target.mkdir()
            audit.ordinary(target, True)
        target /= name.split('/')[-1]
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            with os.fdopen(os.dup(descriptor), 'wb') as stream:
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
        finally: os.close(descriptor)


def prepare(fixture, output):
    fixture = audit.ordinary(fixture, True); registry = audit.ordinary(fixture / 'manifest.json')
    require(registry.stat().st_size < 16384, 'fixture registry exceeds byte bound')
    with registry.open('rb') as stream: registry_bytes = stream.read(16384)
    require(len(registry_bytes) < 16384 and strict_json(registry_bytes) == REGISTRY, 'unexpected committed fixture registry')
    output = Path(os.path.abspath(output)); audit.ordinary(output.parent, True)
    require(not output.exists() and not output.is_symlink(), 'preparation requires a new output directory')
    raw = archive_payloads(fixture / REGISTRY['rawCapture']['file'], REGISTRY['rawCapture'])
    original = validate_inventory(raw, 'public-export-manifest.json', audit.EXPORT_SHA, 'path')
    supplemental = archive_payloads(fixture / REGISTRY['officialRowOracles']['file'], REGISTRY['officialRowOracles'])
    supplemental_manifest = validate_inventory(supplemental, 'manifest.json', SUPPLEMENT_MANIFEST_SHA, 'file')
    require(original['chainId'] == audit.CHAIN and original['privateValuesIncluded'] is False
            and original['fileCount'] == 3753 and original['totalBytes'] == 12148075, 'wrong raw export identity')
    operations, checks, evidence_audit = audit.generate(None, evidence=MemoryEvidence(raw, original))
    linked = linked_oracles(operations, checks, supplemental, supplemental_manifest, raw[audit.CAPTURE + 'schema.bin'])
    require(len(operations) == 1267 and linked['officialCommands'] == 342 and linked['rowOperations'] == 627 and linked['abiOperations'] == 8,
            'unexpected actual corpus qualification inventory')
    derived_values = {'operations.json': operations, 'checks.json': checks, 'audit.json': evidence_audit, 'supplement.json': linked}
    require(sum(len(json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode()) + 1
                for value in derived_values.values()) <= audit.MAX_OUTPUT, 'derived output byte bound exceeded')
    # All archive membership, source derivation and supplemental links have passed before the first write.
    output.mkdir(); audit.ordinary(output, True)
    extract_new(output / 'raw', raw); extract_new(output / 'oracles', supplemental)
    files = audit.write_new(output / 'derived', derived_values)
    return {'schemaVersion': 1, 'status': 'prepared', 'operations': len(operations), 'independentOperations': len(operations),
            'officialRows': linked['rowOperations'], 'officialAbis': linked['abiOperations'], 'officialCommands': linked['officialCommands'],
            'registrySha256': sha(registry_bytes), 'files': files}


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('output'); args = parser.parse_args()
    print(json.dumps(prepare(Path(__file__).parent, args.output), separators=(',', ':')))


if __name__ == '__main__': main()
