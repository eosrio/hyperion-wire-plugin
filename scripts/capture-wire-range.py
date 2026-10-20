"""Bounded, create-only, official-clio SHiP range capture on the selected Linux node host.

No plugin codec, chain write, wallet, SSH or current-head ABI request is used.
Run the unittest module without invoking main to exercise only resource-free logic.
"""
import argparse
import base64
import datetime
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import socket
import stat
import struct
import subprocess
import sys
import time
from urllib.parse import urlsplit


class CaptureError(ValueError):
    pass


class CommandFailure(CaptureError):
    def __init__(self, message, code, stdout, stderr):
        super().__init__(message)
        self.code, self.stdout, self.stderr = code, stdout, stderr


def require(condition, message):
    if not condition:
        raise CaptureError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(data):
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result, 'duplicate JSON key: ' + key)
            result[key] = value
        return result
    def invalid(value):
        raise CaptureError('nonfinite JSON value: ' + value)
    return json.loads(data, object_pairs_hook=pairs, parse_constant=invalid)


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=True, allow_nan=False, indent=2) + '\n').encode()


PROFILES = {'wire-sysio-6508c9e8-engineering-v1': '6508c9e8f4044df8d5acb082a7af3be6a80cd9a0',
            'wire-sysio-7dede884-engineering-v1': '7dede884e0150d36fa788e85a119e10653ade8ca'}
DEFAULT_LIMITS = {'blocks': 128, 'messageBytes': 16 * 1024 * 1024, 'wireBytes': 64 * 1024 * 1024,
                  'storedBytes': 128 * 1024 * 1024, 'seconds': 300, 'ioSeconds': 15, 'oracleSeconds': 20}
MAX_LIMITS = {'blocks': 512, 'messageBytes': 16 * 1024 * 1024, 'wireBytes': 128 * 1024 * 1024,
              'storedBytes': 256 * 1024 * 1024, 'seconds': 900, 'ioSeconds': 30, 'oracleSeconds': 30}
ORACLE_INPUT_LIMIT = 60000  # unpack_hex accepts a literal argv string, not a file/stdin.
ORACLE_OUTPUT_LIMIT = 8 * 1024 * 1024
MANIFEST_RESERVE = 8 * 1024 * 1024


def exact_keys(value, keys, label):
    require(isinstance(value, dict) and set(value) == set(keys), 'invalid ' + label + ' fields')


def integer(value, low, high, label):
    require(type(value) is int and low <= value <= high, 'invalid ' + label)
    return value


def digest(value, size=64):
    require(isinstance(value, str) and re.fullmatch('[0-9a-f]{' + str(size) + '}', value), 'invalid digest/revision')
    return value


def endpoint(value, scheme):
    require(isinstance(value, str), 'endpoint must be text')
    parsed = urlsplit(value)
    require(parsed.scheme == scheme and parsed.hostname == '127.0.0.1' and parsed.port
            and not parsed.username and not parsed.password and parsed.path in ('', '/')
            and not parsed.query and not parsed.fragment, 'only explicit IPv4 loopback root endpoints are allowed')
    return ('127.0.0.1', integer(parsed.port, 1, 65535, 'endpoint port'))


def validate_pins(pins, start, end):
    exact_keys(pins, ['schemaVersion', 'profileId', 'chainId', 'httpUrl', 'shipUrl', 'node', 'clio',
                      'genesis', 'handshakeSha256', 'limits'], 'pins')
    require(pins['schemaVersion'] == 1 and pins['profileId'] in PROFILES, 'unselected capture profile')
    digest(pins['chainId']); digest(pins['handshakeSha256'])
    http_address, ship_address = endpoint(pins['httpUrl'], 'http'), endpoint(pins['shipUrl'], 'ws')
    require(http_address != ship_address, 'HTTP and SHiP listeners must differ')
    exact_keys(pins['node'], ['path', 'sha256', 'sourceRevision', 'serverFullVersion', 'pid', 'startTicks'], 'node')
    exact_keys(pins['clio'], ['path', 'sha256', 'sourceRevision', 'version'], 'clio')
    exact_keys(pins['genesis'], ['path', 'sha256'], 'genesis')
    for item in [pins['node'], pins['clio'], pins['genesis']]:
        require(isinstance(item['path'], str) and PurePosixPath(item['path']).is_absolute(), 'absolute Linux public input path required')
        digest(item['sha256'])
    for item in [pins['node'], pins['clio']]:
        digest(item['sourceRevision'], 40)
    require(pins['node']['sourceRevision'] == PROFILES[pins['profileId']], 'profile/node source pin mismatch')
    require(isinstance(pins['node']['serverFullVersion'], str)
            and pins['node']['sourceRevision'] in pins['node']['serverFullVersion'], 'full node version must identify its pinned revision')
    require(isinstance(pins['clio']['version'], str) and 0 < len(pins['clio']['version']) <= 256, 'invalid clio version pin')
    integer(pins['node']['pid'], 1, 2 ** 31 - 1, 'node PID')
    require(isinstance(pins['node']['startTicks'], str) and re.fullmatch('[1-9][0-9]{0,19}', pins['node']['startTicks']), 'invalid PID start ticks')
    require(isinstance(pins['limits'], dict) and set(pins['limits']).issubset(DEFAULT_LIMITS), 'unknown capture limits')
    limits = {**DEFAULT_LIMITS, **pins['limits']}
    for name, value in limits.items():
        integer(value, 1, MAX_LIMITS[name], name + ' limit')
    require(limits['storedBytes'] >= 12 * 1024 * 1024, 'stored byte limit must reserve the failure manifest')
    integer(start, 1, 0xfffffffe, 'range start'); integer(end, start, 0xfffffffe, 'inclusive range end')
    require(end - start + 1 <= limits['blocks'], 'range exceeds block bound')
    return limits


class Deadline:
    def __init__(self, seconds, clock=time.monotonic):
        self.clock, self.end = clock, clock() + seconds

    def remaining(self, maximum=30):
        remaining = self.end - self.clock()
        require(remaining > 0, 'capture wall-clock deadline exceeded')
        return min(remaining, maximum)


def ordinary(path, directory=False):
    path = Path(os.path.abspath(path))
    for part in reversed([path, *path.parents]):
        info = part.lstat()
        require(not stat.S_ISLNK(info.st_mode), 'symbolic input/output ancestor refused: ' + str(part))
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), 'ordinary file/directory required: ' + str(path))
    return path


def bounded_read(path, maximum):
    with open(path, 'rb') as stream:
        data = stream.read(maximum + 1)
    require(len(data) <= maximum, 'public input exceeds byte bound')
    return data


def regular_bytes(path, maximum):
    path = ordinary(path)
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_size <= maximum, 'public input exceeds file bound')
        with os.fdopen(os.dup(descriptor), 'rb') as stream:
            data = stream.read(maximum + 1)
        after = os.fstat(descriptor)
        require(len(data) <= maximum and before.st_size == after.st_size == len(data)
                and before.st_mtime_ns == after.st_mtime_ns, 'public input changed during read')
        return data
    finally:
        os.close(descriptor)


def executable_hash(path, deadline):
    path = ordinary(path)
    require(path.stat().st_size <= 256 * 1024 * 1024, 'executable exceeds provenance hash budget')
    result, total = hashlib.sha256(), 0
    with open(path, 'rb') as stream:
        while True:
            deadline.remaining()
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk); require(total <= 256 * 1024 * 1024, 'executable grew during provenance read'); result.update(chunk)
    return result.hexdigest()


def process_start_ticks(value, pid):
    require(value.startswith(str(pid) + ' (') and ') ' in value, 'invalid /proc process identity')
    fields = value.rsplit(') ', 1)[1].split()
    require(len(fields) > 19 and re.fullmatch('[0-9]+', fields[19]), 'missing process start ticks')
    return fields[19]


def listening_inodes(table, port):
    result = []
    lines = table.splitlines(); require(len(lines) <= 65536, 'TCP inventory exceeds bound')
    for line in lines[1:]:
        fields = line.split()
        if len(fields) >= 10 and fields[1].upper() == '0100007F:' + format(port, '04X') and fields[3] == '0A':
            require(fields[9].isdigit(), 'invalid listener inode'); result.append(fields[9])
    require(len(result) == 1, 'selected loopback listener is absent or ambiguous')
    return result[0]


def process_genesis_argument(arguments, canonical_path):
    genesis = []
    for index, value in enumerate(arguments):
        if value == '--genesis-json':
            require(index + 1 < len(arguments), 'missing process genesis argument'); genesis.append(arguments[index + 1])
        elif value.startswith('--genesis-json='):
            genesis.append(value.split('=', 1)[1])
    require(len(genesis) == 1 and PurePosixPath(genesis[0]).is_absolute()
            and genesis[0] == str(PurePosixPath(genesis[0])) == canonical_path,
            'explicit canonical absolute pinned --genesis-json association required')
    return genesis[0]


def process_provenance(pins, deadline):
    require(sys.platform.startswith('linux'), 'live capture requires the selected Linux node host and /proc provenance')
    pid = pins['node']['pid']; process = Path('/proc') / str(pid)
    start = process_start_ticks(bounded_read(process / 'stat', 16384).decode(), pid)
    require(start == pins['node']['startTicks'], 'node PID was replaced')
    selected = ordinary(pins['node']['path']); running = os.readlink(process / 'exe')
    require(running == str(selected) and '(deleted)' not in running, 'listener process executable path differs from supplied pin')
    selected_stat, actual_stat = selected.stat(), (process / 'exe').stat()
    require((selected_stat.st_dev, selected_stat.st_ino) == (actual_stat.st_dev, actual_stat.st_ino), 'running executable differs from pinned ordinary file')
    require(executable_hash(selected, deadline) == pins['node']['sha256'], 'node executable hash mismatch')
    arguments = bounded_read(process / 'cmdline', 1024 * 1024).decode().rstrip('\0').split('\0')
    process_genesis_argument(arguments, str(ordinary(pins['genesis']['path'])))
    descriptors = []
    for descriptor in (process / 'fd').iterdir():
        require(len(descriptors) < 4096, 'node descriptor inventory exceeds bound'); descriptors.append(descriptor)
    sockets = set()
    for descriptor in descriptors:
        deadline.remaining()
        try:
            value = os.readlink(descriptor)
        except FileNotFoundError:
            continue
        match = re.fullmatch(r'socket:\[([0-9]+)\]', value)
        if match:
            sockets.add(match[1])
    table = bounded_read(process / 'net/tcp', 8 * 1024 * 1024).decode()
    listeners = {}
    for name, scheme in [('httpUrl', 'http'), ('shipUrl', 'ws')]:
        _, port = endpoint(pins[name], scheme); inode = listening_inodes(table, port)
        require(inode in sockets, 'selected listener is not owned by pinned node PID'); listeners[name] = {'port': port, 'inode': inode, 'address': '127.0.0.1'}
    return {'pid': pid, 'startTicks': start, 'executable': running, 'binarySha256': pins['node']['sha256'],
            'genesisArgumentVerified': True, 'genesisPath': pins['genesis']['path'], 'listeners': listeners}


class TimedSocket(socket.socket):
    @classmethod
    def connect_to(cls, address, deadline, io_seconds):
        original = socket.create_connection(address, timeout=deadline.remaining(io_seconds))
        result = cls(fileno=original.detach()); result.deadline = deadline; result.io_seconds = io_seconds
        return result

    def recv(self, size, flags=0):
        self.settimeout(self.deadline.remaining(self.io_seconds)); return super().recv(size, flags)

    def recv_into(self, buffer, size=0, flags=0):
        self.settimeout(self.deadline.remaining(self.io_seconds)); return super().recv_into(buffer, size, flags)

    def sendall(self, data, flags=0):
        self.settimeout(self.deadline.remaining(self.io_seconds)); return super().sendall(data, flags)


def chain_info(pins, deadline, limits):
    host, port = endpoint(pins['httpUrl'], 'http')
    connection = http.client.HTTPConnection(host, port, timeout=deadline.remaining(limits['ioSeconds']))
    connection._create_connection = lambda address, *_args, **_kwargs: TimedSocket.connect_to(address, deadline, limits['ioSeconds'])
    try:
        connection.request('GET', '/v1/chain/get_info', headers={'Accept': 'application/json'})
        response = connection.getresponse(); require(response.status == 200, 'node get_info did not return HTTP 200')
        data = response.read(256 * 1024 + 1); require(len(data) <= 256 * 1024, 'get_info response exceeds 256 KiB')
        value = strict_json(data)
        require(value.get('chain_id') == pins['chainId'] and value.get('server_full_version_string') == pins['node']['serverFullVersion'], 'wrong node chain/revision before range capture')
        integer(value.get('last_irreversible_block_num'), 0, 0xffffffff, 'node irreversible block')
        return data, value
    finally:
        connection.close()


class Output:
    def __init__(self, path, limits):
        self.path = Path(os.path.abspath(path)); ordinary(self.path.parent, True)
        require(not self.path.exists() and not self.path.is_symlink(), 'refusing existing output')
        self.path.mkdir(); ordinary(self.path, True)
        self.limits, self.files, self.total = limits, [], 0

    def write(self, name, data, final=False):
        require(isinstance(data, bytes) and re.fullmatch('[A-Za-z0-9_./-]+', name), 'invalid output name/data')
        parts = name.split('/'); require(all(part not in ('', '.', '..') for part in parts), 'output traversal refused')
        require(len(self.files) < (8192 if final else 8191), 'stored file-count bound exceeded')
        maximum = self.limits['storedBytes'] if final else self.limits['storedBytes'] - MANIFEST_RESERVE
        require(self.total + len(data) <= maximum, 'stored byte bound exceeded')
        target = self.path
        for part in parts[:-1]:
            target /= part
            try:
                target.mkdir()
            except FileExistsError:
                pass
            ordinary(target, True)
        target /= parts[-1]
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            with os.fdopen(os.dup(descriptor), 'wb') as stream:
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
        finally:
            os.close(descriptor)
        # Source/request/ACK files are durable before subsequent SHiP credit is issued.
        if os.name == 'posix':
            directory = os.open(target.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        record = {'file': name, 'bytes': len(data), 'sha256': sha(data)}; self.files.append(record); self.total += len(data)
        return record


def run_bounded(arguments, deadline, timeout):
    # Fix the command allowance before spawning; setup time never restarts it.
    end = time.monotonic() + deadline.remaining(timeout)
    selector = None; values = {'stdout': bytearray(), 'stderr': bytearray()}; failure = None
    process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        deadline.remaining(timeout)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ, 'stdout'); selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
        while selector.get_map():
            remaining = min(deadline.remaining(timeout), end - time.monotonic()); require(remaining > 0, 'official clio timeout')
            events = selector.select(min(remaining, 0.25))
            for key, _ in events:
                remaining_bytes = ORACLE_OUTPUT_LIMIT - sum(map(len, values.values()))
                data = os.read(key.fileobj.fileno(), min(65536, remaining_bytes + 1))
                if not data:
                    selector.unregister(key.fileobj); continue
                values[key.data].extend(data[:remaining_bytes]); require(len(data) <= remaining_bytes, 'official clio output bound exceeded')
        remaining = min(deadline.remaining(timeout), end - time.monotonic()); require(remaining > 0, 'official clio timeout')
        code = process.wait(timeout=remaining)
    except Exception as error:
        failure = error
    finally:
        try:
            if process.poll() is None:
                try:
                    process.kill()
                finally:
                    # Emergency reap is bounded; it grants no further command execution.
                    process.wait(timeout=5)
        finally:
            try:
                if selector is not None:
                    selector.close()
            finally:
                try:
                    process.stdout.close()
                finally:
                    process.stderr.close()
    if failure is not None:
        raise CommandFailure(str(failure), process.returncode, bytes(values['stdout']), bytes(values['stderr'])) from failure
    return code, bytes(values['stdout']), bytes(values['stderr'])


class Oracle:
    def __init__(self, pins, output, deadline, limits, runner=run_bounded):
        self.pins, self.output, self.deadline, self.limits, self.runner = pins, output, deadline, limits, runner
        self.commands, self.exclusions = [], []

    def command(self, arguments):
        require(len(self.commands) < 4 * self.limits['blocks'] + 16, 'official command-count bound exceeded')
        number = len(self.commands) + 1; prefix = 'oracle/%05d' % number
        failure = None
        try:
            code, stdout, stderr = self.runner([self.pins['clio']['path'], *arguments], self.deadline, self.limits['oracleSeconds'])
        except CommandFailure as error:
            code, stdout, stderr, failure = error.code, error.stdout, error.stderr, str(error)
        # Keep exact literal arguments in their own hashed file; repeated source hex must not inflate the final manifest.
        record = {'argumentsFile': self.output.write(prefix + '-arguments.json', json_bytes(arguments)), 'exitCode': code,
                  'stdout': self.output.write(prefix + '-stdout.bin', stdout), 'stderr': self.output.write(prefix + '-stderr.bin', stderr)}
        if failure is not None:
            record.update(failure=failure, outputComplete=False)
        self.commands.append(record)
        require(failure is None, 'official clio execution failed: ' + str(failure))
        require(code == 0 and stdout.strip() and b'ERROR: Unable to convert' not in stderr, 'official clio rejected input (including exit-zero serialization failure)')
        return stdout

    def decode(self, type_name, blob):
        # Raw source has already been saved; never exceed Linux's literal argv limit or fabricate an oracle.
        if len(blob) > ORACLE_INPUT_LIMIT:
            self.exclusions.append({'operation': 'decode', 'type': type_name, 'bytes': len(blob), 'sha256': sha(blob), 'reason': 'literal-argv-limit'})
            raise CaptureError('raw input retained, but official unpack_hex argv oracle exceeds 60000 bytes')
        return strict_json(self.command(['convert', 'unpack_hex', blob.hex(), '--type', type_name,
                                         '--abi-file', str(self.output.path / 'schema.bin')]))

    def pack(self, value, label):
        self.output.write('requests/' + label + '.json', json_bytes(value))
        result = strict_json(self.command(['convert', 'pack_hex', str(self.output.path / ('requests/' + label + '.json')),
                                         '--type', 'request', '--abi-file', str(self.output.path / 'schema.bin')]))
        require(isinstance(result, str) and re.fullmatch('(?:[0-9a-fA-F]{2})+', result), 'official request oracle did not return exact hex')
        blob = bytes.fromhex(result); self.output.write('requests/' + label + '.bin', blob)
        return blob


class WebSocket:
    def __init__(self, stream, output, deadline, limits, mask=os.urandom):
        self.stream, self.output, self.deadline, self.limits, self.mask = stream, output, deadline, limits, mask
        self.buffer, self.wire_bytes, self.frames, self.transcript = b'', 0, 0, []

    def receive_bytes(self, maximum):
        self.stream.settimeout(self.deadline.remaining(self.limits['ioSeconds']))
        remaining = self.limits['wireBytes'] - self.wire_bytes; require(remaining > 0, 'wire byte budget exceeded')
        data = self.stream.recv(min(maximum, remaining)); require(data, 'unexpected socket EOF')
        self.wire_bytes += len(data)
        return data

    def read(self, size):
        while len(self.buffer) < size:
            self.buffer += self.receive_bytes(min(65536, size - len(self.buffer)))
        data, self.buffer = self.buffer[:size], self.buffer[size:]; return data

    def record(self, direction, raw, opcode, complete=True):
        self.frames += 1; require(self.frames <= 4096, 'WebSocket frame-count bound exceeded')
        item = {'direction': direction, 'opcode': opcode, 'complete': complete,
                **self.output.write('transport/%05d-%s.bin' % (self.frames, direction), raw)}
        self.transcript.append(item); return item

    def send(self, payload, opcode=2):
        require(len(payload) <= self.limits['messageBytes'] and (opcode < 8 or len(payload) <= 125), 'outgoing frame exceeds bound')
        mask = self.mask(4); require(len(mask) == 4, 'invalid WebSocket mask')
        length = len(payload)
        header = bytes([0x80 | opcode, 0x80 | length]) if length < 126 else bytes([0x80 | opcode, 0xfe]) + struct.pack('>H', length) if length < 65536 else bytes([0x80 | opcode, 0xff]) + struct.pack('>Q', length)
        raw = header + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        item = self.record('out', raw, opcode); item['sendallReturned'] = False
        self.stream.settimeout(self.deadline.remaining(self.limits['ioSeconds'])); self.stream.sendall(raw); item['sendallReturned'] = True

    def upgrade(self, port):
        key = base64.b64encode(self.mask(16)).decode()
        request = ('GET / HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n' % (port, key)).encode()
        self.output.write('transport/upgrade-request.bin', request); self.stream.sendall(request)
        header = b''
        while b'\r\n\r\n' not in header:
            header += self.receive_bytes(4096); require(len(header) <= 16384, 'oversized WebSocket upgrade response')
        response, self.buffer = header.split(b'\r\n\r\n', 1); self.output.write('transport/upgrade-response.bin', response + b'\r\n\r\n')
        lines = response.decode('ascii').split('\r\n'); require(lines[0].startswith('HTTP/1.1 101 '), 'WebSocket upgrade did not return 101')
        headers = {}
        for line in lines[1:]:
            require(':' in line, 'malformed WebSocket upgrade header'); name, value = line.split(':', 1); name = name.lower()
            require(name not in headers, 'duplicate WebSocket header'); headers[name] = value.strip()
        require(headers.get('upgrade', '').lower() == 'websocket' and 'upgrade' in [value.strip() for value in headers.get('connection', '').lower().split(',')], 'invalid upgrade headers')
        require('sec-websocket-extensions' not in headers and 'sec-websocket-protocol' not in headers, 'unsolicited WebSocket extension/protocol')
        accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        require(headers.get('sec-websocket-accept') == accept, 'WebSocket accept mismatch')

    def receive(self):
        chunks, opcode, total = [], None, 0
        while True:
            observed = bytearray()
            def read_part(size):
                try:
                    data = self.read(size)
                except Exception:
                    partial = bytes(observed) + self.buffer; self.buffer = b''
                    if partial:
                        self.record('in', partial, partial[0] & 15, False)
                    raise
                observed.extend(data); return data
            header = read_part(2); first, second = header; encoded_length = length = second & 127
            if length == 126:
                extra = read_part(2); header += extra; length = struct.unpack('>H', extra)[0]
            elif length == 127:
                extra = read_part(8); header += extra; length = struct.unpack('>Q', extra)[0]
            if (encoded_length == 126 and length < 126) or (encoded_length == 127 and not 65536 <= length < 2 ** 63):
                self.record('in', header, first & 15, False); raise CaptureError('noncanonical WebSocket length')
            current, final = first & 15, bool(first & 0x80)
            if first & 0x70 or second & 0x80 or length > self.limits['messageBytes'] or (current >= 8 and (not final or length > 125)):
                self.record('in', header, current, False); raise CaptureError('masked/reserved/oversized or invalid control frame')
            payload = read_part(length); self.record('in', header + payload, current)
            if current == 9:
                self.send(payload, 10); continue
            if current == 10:
                continue
            require(current != 8, 'server closed before requested range completed')
            require(current in (1, 2) if opcode is None else current == 0, 'unexpected WebSocket continuation/opcode')
            if opcode is None:
                opcode = current
            total += len(payload); require(total <= self.limits['messageBytes'], 'fragmented message exceeds byte bound'); chunks.append(payload)
            if final:
                return opcode, b''.join(chunks)


def hex_bytes(value, label):
    require(isinstance(value, str) and re.fullmatch('(?:[0-9a-fA-F]{2})+', value), 'missing/nonhex original ' + label)
    return bytes.fromhex(value)


def position(value, label):
    exact_keys(value, ['block_num', 'block_id'], label)
    number = integer(value['block_num'], 0, 0xffffffff, label + ' block')
    require(isinstance(value['block_id'], str) and re.fullmatch('[0-9a-fA-F]{64}', value['block_id']), 'invalid block position digest')
    return number, value['block_id'].lower()


class RangeOrder:
    def __init__(self, start, end):
        self.start, self.end, self.next, self.previous, self.first_previous = start, end, start, None, None

    def accept(self, result, signed_block):
        require(self.next <= self.end, 'unexpected extra source block')
        require(isinstance(result, dict) and isinstance(signed_block, dict), 'invalid official block/result shape')
        number, block_id = position(result.get('this_block'), 'source')
        require(number == self.next, 'missing, duplicate or out-of-order source block')
        previous = position(result['prev_block'], 'previous') if result.get('prev_block') is not None else None
        if previous is not None:
            require(previous[0] == number - 1, 'source previous position has wrong height')
            require(isinstance(signed_block.get('previous'), str) and signed_block['previous'].lower() == previous[1], 'signed block/source previous IDs differ')
        if self.previous is not None:
            require(previous == self.previous, 'range contains an inconsistent parent link')
        else:
            self.first_previous = previous
        require(position(result.get('last_irreversible'), 'source irreversible')[0] >= self.end, 'source interval is not already irreversible')
        self.previous = (number, block_id); self.next += 1
        return {'blockNum': number, 'blockId': block_id, 'previousPosition': previous}

    def finish(self):
        require(self.next == self.end + 1, 'capture ended before complete requested membership')


def verify_status(value, pins, start, end):
    require(isinstance(value, list) and len(value) == 2 and value[0] in ('get_status_result_v0', 'get_status_result_v1'), 'unexpected status result variant')
    status = value[1]; require(status.get('chain_id') == pins['chainId'], 'SHiP chain differs from pinned HTTP node')
    require(position(status.get('last_irreversible'), 'status irreversible')[0] >= end, 'requested range is not irreversible in SHiP status')
    for name in ['trace', 'chain_state']:
        require(integer(status.get(name + '_begin_block'), 0, 0xffffffff, 'retention start') <= start
                and integer(status.get(name + '_end_block'), 0, 0xffffffff, 'retention end') > end, 'requested range is outside complete trace/delta retention')


def capture(pins_bytes, output_path, start, end):
    pins = strict_json(pins_bytes); limits = validate_pins(pins, start, end); deadline = Deadline(limits['seconds'])
    # These identity checks precede output creation, any SHiP request, and any capture of block data.
    before_process = process_provenance(pins, deadline)
    require(executable_hash(pins['clio']['path'], deadline) == pins['clio']['sha256'], 'clio executable hash mismatch')
    genesis = regular_bytes(pins['genesis']['path'], 4 * 1024 * 1024); require(sha(genesis) == pins['genesis']['sha256'], 'genesis file hash mismatch')
    code, version, version_error = run_bounded([pins['clio']['path'], 'version', 'client'], deadline, limits['oracleSeconds'])
    require(code == 0 and version.decode().strip() == pins['clio']['version'], 'official clio version mismatch')
    before_bytes, before = chain_info(pins, deadline, limits)
    require(end <= before['last_irreversible_block_num'], 'range end must already be irreversible before capture starts')
    output = Output(output_path, limits); stream = None; transport = None
    manifest = {'schemaVersion': 1, 'status': 'incomplete', 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'driver': {'sha256': sha(regular_bytes(__file__, 128 * 1024)), 'python': sys.version, 'platform': sys.platform},
                'profileId': pins['profileId'], 'pins': pins, 'limits': {**limits, 'oracleInputBytes': ORACLE_INPUT_LIMIT,
                    'oracleOutputBytes': ORACLE_OUTPUT_LIMIT, 'httpResponseBytes': 256 * 1024, 'frames': 4096, 'files': 8192},
                'range': {'startBlock': start, 'endBlockInclusive': end, 'complete': False}, 'blocks': [], 'commands': [],
                'initialAncestry': {'status': 'unknown-before-range', 'abiFrontier': 'not-supplied', 'currentHeadAbiFallback': False},
                'deltaFraming': {'status': 'not-independently-audited', 'knownUpstreamCountDefectPossible': True,
                                 'fullOracleConsumptionVerified': False, 'rawBytesRetained': True},
                'qualification': {'status': 'incomplete', 'applicationCoverage': 'not-inferred', 'sourceAuthority': False, 'selectedTestnet': False},
                'scope': ['Raw irreversible-range capture and independent official-clio observations only.',
                          'Prior ancestry and ABI frontier are unknown; a predecessor reference does not establish verified state.',
                          'Official clio can omit trailing delta streams; retained raw bytes, not this oracle JSON alone, preserve their membership.',
                          'No plugin-codec, host indexing, sink/canonical/PIT, Node/Rust parity, performance or selected-testnet acceptance.'],
                'processBefore': before_process, 'clioVersionCommand': {'arguments': ['version', 'client'], 'exitCode': code}}
    oracle = Oracle(pins, output, deadline, limits)
    try:
        output.write('pins.json', pins_bytes); output.write('genesis.json', genesis)
        output.write('node-info-before.json', before_bytes); output.write('clio-version-stdout.bin', version); output.write('clio-version-stderr.bin', version_error)
        address = endpoint(pins['shipUrl'], 'ws'); stream = TimedSocket.connect_to(address, deadline, limits['ioSeconds'])
        transport = WebSocket(stream, output, deadline, limits); transport.upgrade(address[1])
        opcode, schema = transport.receive(); require(opcode == 1, 'first SHiP message is not its text schema')
        output.write('schema.bin', schema); strict_json(schema)
        require(sha(schema) == pins['handshakeSha256'], 'SHiP schema hash differs from supplied pin before source request')
        status_request = oracle.pack(['get_status_request_v0', {}], 'status'); require(status_request == b'\x00', 'unexpected official status request bytes')
        transport.send(status_request); opcode, status = transport.receive(); require(opcode == 2, 'status must be binary')
        output.write('status.bin', status); decoded_status = oracle.decode('result', status); output.write('status-oracle.json', json_bytes(decoded_status)); verify_status(decoded_status, pins, start, end)
        require(process_provenance(pins, deadline) == before_process, 'selected listener/process identity changed before source request')
        request_value = ['get_blocks_request_v0', {'start_block_num': start, 'end_block_num': end + 1, 'max_messages_in_flight': 1,
            'have_positions': [], 'irreversible_only': True, 'fetch_block': True, 'fetch_traces': True, 'fetch_deltas': True}]
        request = oracle.pack(request_value, 'range'); ack = oracle.pack(['get_blocks_ack_request_v0', {'num_messages': 1}], 'ack')
        require(ack == b'\x02\x01\x00\x00\x00', 'unexpected official ACK bytes')
        transport.send(request); order = RangeOrder(start, end)
        for ordinal in range(end - start + 1):
            deadline.remaining(); opcode, frame = transport.receive(); require(opcode == 2, 'block result must be binary')
            prefix = 'blocks/%05d' % ordinal; source = output.write(prefix + '-result.bin', frame)
            result = oracle.decode('result', frame); output.write(prefix + '-result-oracle.json', json_bytes(result))
            require(isinstance(result, list) and len(result) == 2 and result[0] in ('get_blocks_result_v0', 'get_blocks_result_v1'), 'unexpected block result variant')
            decoded, nested = {}, {}
            for field, type_name in [('block', 'signed_block'), ('traces', 'transaction_trace[]'), ('deltas', 'table_delta[]')]:
                blob = hex_bytes(result[1].get(field), field); nested[field] = output.write(prefix + '-' + field + '.bin', blob)
                decoded[field] = oracle.decode(type_name, blob); output.write(prefix + '-' + field + '-oracle.json', json_bytes(decoded[field]))
            require(isinstance(decoded['block'], dict) and isinstance(decoded['traces'], list) and isinstance(decoded['deltas'], list), 'unexpected nested official oracle shapes')
            record = {**order.accept(result[1], decoded['block']), 'ordinal': ordinal, 'source': source, 'payloads': nested,
                      'traceTransactions': len(decoded['traces']) if isinstance(decoded['traces'], list) else None, 'ack': {'payloadSha256': sha(ack), 'sendallReturned': False}}
            manifest['blocks'].append(record)
            # Raw input, nested bytes, oracle outputs and request/ACK inputs are fsynced before credit.
            transport.send(ack); record['ack']['sendallReturned'] = True
        order.finish(); manifest['initialAncestry']['firstPreviousPosition'] = order.first_previous
        transport.send(struct.pack('>H', 1000), 8); stream.close(); stream = None
        after_bytes, after = chain_info(pins, deadline, limits); output.write('node-info-after.json', after_bytes)
        require(after['last_irreversible_block_num'] >= before['last_irreversible_block_num'], 'node irreversible height regressed during capture')
        manifest['processAfter'] = process_provenance(pins, deadline)
        require(manifest['processAfter'] == before_process, 'node/listener identity changed during capture')
        manifest['status'] = 'captured'; manifest['range']['complete'] = True
    except Exception as error:
        manifest['error'] = {'type': type(error).__name__, 'message': str(error)[:4096]}
    finally:
        if stream is not None:
            stream.close()
        manifest['commands'] = oracle.commands; manifest['oracleExclusions'] = oracle.exclusions
        manifest['transport'] = transport.transcript if transport else []
        manifest['files'] = list(output.files); manifest['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        output.write('manifest.json', json_bytes(manifest), final=True)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pins', required=True); parser.add_argument('--output', required=True)
    parser.add_argument('--start', required=True, type=int); parser.add_argument('--end', required=True, type=int)
    args = parser.parse_args()
    result = capture(regular_bytes(args.pins, 65536), args.output, args.start, args.end)
    print(json.dumps({'status': result['status'], 'output': os.path.abspath(args.output), 'capturedBlocks': len(result['blocks']),
                      'rangeComplete': result['range']['complete'], 'manifestSha256': sha(json_bytes(result)),
                      'qualification': 'incomplete', 'error': result.get('error')}))
    return 0 if result['status'] == 'captured' else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (CaptureError, OSError, json.JSONDecodeError) as failure:
        print(type(failure).__name__ + ': ' + str(failure), file=sys.stderr); sys.exit(1)
