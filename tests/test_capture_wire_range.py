"""Resource-free capture regressions: no sockets, node, clio, SSH or existing fixture changes."""
import copy
import importlib.util
from pathlib import Path
import struct
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location('capture_wire_range', Path(__file__).resolve().parents[1] / 'scripts/capture-wire-range.py')
capture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capture)


def pins():
    return {'schemaVersion': 1, 'profileId': 'wire-sysio-7dede884-engineering-v1', 'chainId': '1' * 64,
            'httpUrl': 'http://127.0.0.1:18889', 'shipUrl': 'ws://127.0.0.1:18081/',
            'node': {'path': '/owned/nodeos', 'sha256': '2' * 64, 'sourceRevision': capture.PROFILES['wire-sysio-7dede884-engineering-v1'],
                     'serverFullVersion': 'v1.0.0-' + capture.PROFILES['wire-sysio-7dede884-engineering-v1'], 'pid': 123, 'startTicks': '456'},
            'clio': {'path': '/owned/clio', 'sha256': '3' * 64, 'sourceRevision': capture.PROFILES['wire-sysio-7dede884-engineering-v1'], 'version': 'v1.0.0'},
            'genesis': {'path': '/owned/genesis.json', 'sha256': '4' * 64}, 'handshakeSha256': '5' * 64, 'limits': {}}


class MemoryOutput:
    path = Path('/owned/capture')

    def __init__(self):
        self.files = {}

    def write(self, name, data, final=False):
        if name in self.files:
            raise AssertionError('attempted overwrite')
        self.files[name] = data
        return {'file': name, 'bytes': len(data), 'sha256': capture.sha(data)}


class FakeSocket:
    def __init__(self, data):
        self.data, self.sent = data, []

    def recv(self, size):
        value, self.data = self.data[:min(size, 3)], self.data[min(size, 3):]
        return value

    def settimeout(self, timeout):
        if timeout <= 0:
            raise AssertionError('unbounded socket')

    def sendall(self, data):
        self.sent.append(data)


def frame(payload, opcode=2, final=True, masked=False, reserved=False):
    first = (0x80 if final else 0) | (0x40 if reserved else 0) | opcode
    length = len(payload)
    prefix = bytes([first, length if length < 126 else 126]) + (struct.pack('>H', length) if length >= 126 else b'')
    if masked:
        prefix = bytes([prefix[0], prefix[1] | 0x80]) + prefix[2:]
    return prefix + payload


def transport(data, **limits):
    output, stream = MemoryOutput(), FakeSocket(data)
    return capture.WebSocket(stream, output, capture.Deadline(10), {**capture.DEFAULT_LIMITS, **limits}, mask=lambda length: b'm' * length)


def position(number):
    return {'block_num': number, 'block_id': format(number, '064x')}


def result(number, previous=None):
    return {'this_block': position(number), 'prev_block': position(number - 1) if previous is None else previous,
            'last_irreversible': position(20)}


class PinTests(unittest.TestCase):
    def test_selected_pins_and_inclusive_uint32_range(self):
        self.assertEqual(capture.validate_pins(pins(), 2, 20)['blocks'], 128)
        for low, high in [(0, 1), (3, 2), (1, 514), (1, 0xffffffff), (True, 2)]:
            with self.subTest(low=low, high=high), self.assertRaises(capture.CaptureError):
                capture.validate_pins(pins(), low, high)

    def test_wrong_source_unknown_fields_and_unbounded_limits(self):
        for mutate in [lambda p: p['node'].update(sourceRevision='0' * 40), lambda p: p.update(privateKey='forbidden'),
                       lambda p: p['limits'].update(seconds=901), lambda p: p['limits'].update(socketForever=1),
                       lambda p: p['node'].update(startTicks='0456'), lambda p: p['node'].update(path='relative')]:
            value = pins(); mutate(value)
            with self.assertRaises(capture.CaptureError):
                capture.validate_pins(value, 2, 3)

    def test_endpoints_never_resolve_external_hosts_or_credentials(self):
        for value in ['http://localhost:18889', 'http://0.0.0.0:18889', 'http://example.com:18889',
                      'https://127.0.0.1:18889', 'http://u:p@127.0.0.1:18889', 'http://127.0.0.1:18889/x',
                      'http://127.0.0.1:18889/?x=1', 'http://127.0.0.1:18889/#x']:
            with self.subTest(value=value), self.assertRaises(capture.CaptureError):
                capture.endpoint(value, 'http')

    def test_strict_json_rejects_duplicate_and_nonfinite_values(self):
        for value in [b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}']:
            with self.assertRaises(capture.CaptureError):
                capture.strict_json(value)
        self.assertEqual(capture.strict_json(b'{"sequence":18446744073709551615}')['sequence'], 18446744073709551615)

    def test_linux_process_and_explicit_listener_identity_parsers(self):
        fields = ['S'] + ['0'] * 18 + ['456']
        self.assertEqual(capture.process_start_ticks('123 (name with ) brackets) ' + ' '.join(fields), 123), '456')
        with self.assertRaises(capture.CaptureError):
            capture.process_start_ticks('124 (wrong) ' + ' '.join(fields), 123)
        line = '0: 0100007F:49C9 00000000:0000 0A 0:0 0:0 0 1000 0 12345'
        self.assertEqual(capture.listening_inodes('header\n' + line, 18889), '12345')
        for table in ['header\n' + line.replace('0100007F', '00000000'), 'header\n' + line + '\n' + line]:
            with self.assertRaises(capture.CaptureError):
                capture.listening_inodes(table, 18889)

    def test_monotonic_deadline_is_not_extended_by_progress(self):
        now = [1.0]; deadline = capture.Deadline(2, clock=lambda: now[0]); self.assertEqual(deadline.remaining(10), 2)
        now[0] = 2.5; self.assertEqual(deadline.remaining(10), 0.5); now[0] = 3.0
        with self.assertRaises(capture.CaptureError):
            deadline.remaining()


    def test_process_genesis_binds_original_canonical_absolute_text(self):
        selected = '/owned/genesis.json'
        for arguments in [['nodeos', '--genesis-json', selected], ['nodeos', '--genesis-json=' + selected]]:
            self.assertEqual(capture.process_genesis_argument(arguments, selected), selected)
        for arguments in [['nodeos'], ['nodeos', '--genesis-json'], ['nodeos', '--genesis-json='],
                          ['nodeos', '--genesis-json', 'genesis.json'],
                          ['nodeos', '--genesis-json', '/owned/./genesis.json'],
                          ['nodeos', '--genesis-json', '/owned/sub/../genesis.json'],
                          ['nodeos', '--genesis-json', '/owned//genesis.json'],
                          ['nodeos', '--genesis-json', '/alias/genesis.json'],
                          ['nodeos', '--genesis-json', selected, '--genesis-json=' + selected]]:
            # A relative flag must not acquire authority from the capture driver's cwd.
            with self.subTest(arguments=arguments), patch.object(capture.os, 'getcwd', return_value='/owned'), \
                 self.assertRaises(capture.CaptureError):
                capture.process_genesis_argument(arguments, selected)


class ProcessCleanupTests(unittest.TestCase):
    """Popen, selector and clock are controlled: no child process is launched."""
    def process(self):
        value = Mock(); value.returncode = None; value.poll.side_effect = lambda: value.returncode
        def wait(timeout):
            self.assertGreater(timeout, 0); self.assertLessEqual(timeout, 5)
            value.returncode = -9; return value.returncode
        value.wait.side_effect = wait
        return value

    def assert_cleaned(self, process):
        process.kill.assert_called_once_with(); process.wait.assert_called_once_with(timeout=5)
        process.stdout.close.assert_called_once_with(); process.stderr.close.assert_called_once_with()

    def test_expired_deadline_never_spawns_or_constructs_selector(self):
        now = [0]; deadline = capture.Deadline(1, clock=lambda: now[0]); now[0] = 1
        with patch.object(capture.subprocess, 'Popen') as spawn, patch.object(capture.selectors, 'DefaultSelector') as selector, \
             self.assertRaises(capture.CaptureError):
            capture.run_bounded(['clio'], deadline, 10)
        spawn.assert_not_called(); selector.assert_not_called()

    def test_expiry_after_spawn_still_kills_reaps_and_closes_both_pipes(self):
        process = self.process(); deadline = Mock()
        deadline.remaining.side_effect = [2, capture.CaptureError('expired after spawn')]
        with patch.object(capture.subprocess, 'Popen', return_value=process), patch.object(capture.selectors, 'DefaultSelector') as selector, \
             self.assertRaisesRegex(capture.CommandFailure, 'expired after spawn') as raised:
            capture.run_bounded(['clio'], deadline, 10)
        self.assert_cleaned(process); selector.assert_not_called(); self.assertEqual(raised.exception.code, -9)

    def test_selector_constructor_or_either_registration_failure_cleans_owned_resources(self):
        for step in ['constructor', 'stdout', 'stderr']:
            process, selector = self.process(), Mock()
            if step != 'constructor':
                selector.register.side_effect = [OSError(step)] if step == 'stdout' else [None, RuntimeError(step)]
            with self.subTest(step=step), patch.object(capture.subprocess, 'Popen', return_value=process), \
                 patch.object(capture.selectors, 'DefaultSelector', side_effect=OSError(step) if step == 'constructor' else None,
                              return_value=selector), self.assertRaisesRegex(capture.CommandFailure, step):
                capture.run_bounded(['clio'], capture.Deadline(10), 2)
            self.assert_cleaned(process)
            if step != 'constructor':
                selector.close.assert_called_once_with()

    def test_cleanup_closes_both_pipes_even_when_selector_close_raises(self):
        process, selector = self.process(), Mock(); selector.register.side_effect = OSError('setup')
        selector.close.side_effect = OSError('close')
        with patch.object(capture.subprocess, 'Popen', return_value=process), \
             patch.object(capture.selectors, 'DefaultSelector', return_value=selector), self.assertRaisesRegex(OSError, 'close'):
            capture.run_bounded(['clio'], capture.Deadline(10), 2)
        self.assert_cleaned(process)

    def test_kill_race_still_reaps_and_closes_selector_and_pipes(self):
        process, selector = self.process(), Mock(); selector.register.side_effect = OSError('setup')
        process.kill.side_effect = ProcessLookupError('already exited')
        with patch.object(capture.subprocess, 'Popen', return_value=process), \
             patch.object(capture.selectors, 'DefaultSelector', return_value=selector), self.assertRaises(ProcessLookupError):
            capture.run_bounded(['clio'], capture.Deadline(10), 2)
        self.assert_cleaned(process); selector.close.assert_called_once_with()

    def test_reap_failure_still_closes_selector_and_both_pipes(self):
        process, selector = self.process(), Mock(); selector.register.side_effect = OSError('setup')
        process.wait.side_effect = capture.subprocess.TimeoutExpired(['clio'], 5)
        with patch.object(capture.subprocess, 'Popen', return_value=process), \
             patch.object(capture.selectors, 'DefaultSelector', return_value=selector), self.assertRaises(capture.subprocess.TimeoutExpired):
            capture.run_bounded(['clio'], capture.Deadline(10), 2)
        self.assert_cleaned(process); selector.close.assert_called_once_with()

    def test_setup_time_consumes_fixed_command_allowance(self):
        process, selector = self.process(), Mock(); selector.get_map.return_value = {}
        deadline = Mock(); deadline.remaining.return_value = 10
        with patch.object(capture.subprocess, 'Popen', return_value=process), \
             patch.object(capture.selectors, 'DefaultSelector', return_value=selector), \
             patch.object(capture.time, 'monotonic', side_effect=[0, 11]), self.assertRaisesRegex(capture.CommandFailure, 'clio timeout'):
            capture.run_bounded(['clio'], deadline, 10)
        self.assert_cleaned(process); selector.close.assert_called_once_with()


class WebSocketTests(unittest.TestCase):
    def test_fragmented_messages_ping_pong_and_exact_original_wire_bytes(self):
        raw = frame(b'ab', final=False) + frame(b'ping', 9) + frame(b'cd', 0)
        value = transport(raw); self.assertEqual(value.receive(), (2, b'abcd'))
        observed = [value.output.files[row['file']] for row in value.transcript if row['direction'] == 'in']
        self.assertEqual(b''.join(observed), raw); self.assertEqual(value.transcript[2]['opcode'], 10)
        self.assertTrue(value.transcript[2]['sendallReturned']); self.assertEqual(value.stream.sent[0][0], 0x8a)

    def test_unfragmented_text_and_binary_are_kept_separate(self):
        value = transport(frame(b'{}', 1) + frame(b'\x00\x01', 2))
        self.assertEqual(value.receive(), (1, b'{}')); self.assertEqual(value.receive(), (2, b'\x00\x01'))

    def test_server_mask_extensions_control_and_opcode_failures_are_bounded(self):
        for data in [frame(b'x', masked=True), frame(b'x', reserved=True), frame(b'x', 9, False),
                     frame(b'x' * 126, 9), frame(b'x', 0), frame(b'x', 8), frame(b'x', 3),
                     frame(b'a', 2, False) + frame(b'b', 2), b'\x82\x7e\x00\x01x']:
            with self.subTest(data=data[:8]), self.assertRaises(capture.CaptureError):
                transport(data).receive()

    def test_message_wire_and_fragment_bounds_stop_without_credit(self):
        for value in [transport(frame(b'abcd'), messageBytes=3), transport(frame(b'ab', final=False) + frame(b'cd', 0), messageBytes=3),
                      transport(frame(b'abcdef'), wireBytes=4)]:
            with self.assertRaises(capture.CaptureError):
                value.receive()
            self.assertEqual(value.stream.sent, [])

    def test_oversized_header_is_retained_without_allocating_declared_body(self):
        value = transport(b'\x82\x7f' + struct.pack('>Q', 2 ** 40))
        with self.assertRaises(capture.CaptureError):
            value.receive()
        self.assertEqual(len(value.transcript), 1); self.assertFalse(value.transcript[0]['complete'])

    def test_eof_preserves_partial_header_extended_length_and_payload_exactly_once(self):
        for raw in [b'\x82', b'\x82\x7e\x00', b'\x82\x7f\x00\x00\x00', b'\x82\x0aabc']:
            value = transport(raw)
            with self.subTest(raw=raw), self.assertRaisesRegex(capture.CaptureError, 'EOF'):
                value.receive()
            self.assertEqual(len(value.transcript), 1); self.assertFalse(value.transcript[0]['complete'])
            self.assertEqual(value.output.files[value.transcript[0]['file']], raw); self.assertEqual(value.stream.sent, [])

    def test_noncanonical_extended_lengths_preserve_only_the_exact_rejected_header(self):
        headers = [b'\x82\x7e' + struct.pack('>H', length) for length in [0, 1, 125]]
        headers += [b'\x82\x7f' + struct.pack('>Q', length) for length in [0, 126, 65535, 2 ** 63, 2 ** 64 - 1]]
        for header in headers:
            value = transport(header + b'unread-body')
            with self.subTest(header=header), self.assertRaisesRegex(capture.CaptureError, 'noncanonical'):
                value.receive()
            self.assertEqual(len(value.transcript), 1); self.assertFalse(value.transcript[0]['complete'])
            self.assertEqual(value.transcript[0]['opcode'], 2); self.assertEqual(value.stream.data, b'unread-body')
            self.assertEqual(value.output.files[value.transcript[0]['file']], header); self.assertEqual(value.stream.sent, [])

    def test_timeout_preserves_partial_continuation_without_duplicating_complete_frame(self):
        first, partial = frame(b'ab', final=False), b'\x80\x04c'
        value = transport(first + partial); original_recv = value.stream.recv
        def recv(size):
            if not value.stream.data:
                raise TimeoutError('controlled partial timeout')
            return original_recv(size)
        value.stream.recv = recv
        with self.assertRaisesRegex(TimeoutError, 'controlled partial timeout'):
            value.receive()
        self.assertEqual([row['complete'] for row in value.transcript], [True, False])
        self.assertEqual([value.output.files[row['file']] for row in value.transcript], [first, partial])
        self.assertEqual(value.stream.sent, [])

    def test_outbound_payload_masking_is_exact_and_saved_before_send(self):
        value = transport(b''); value.send(b'\x02\x01\x00\x00\x00')
        raw = value.stream.sent[0]; self.assertEqual(raw, value.output.files[value.transcript[0]['file']])
        self.assertTrue(raw[1] & 128); mask = raw[2:6]
        self.assertEqual(bytes(byte ^ mask[i % 4] for i, byte in enumerate(raw[6:])), b'\x02\x01\x00\x00\x00')


class MembershipAndOracleTests(unittest.TestCase):
    def test_contiguous_source_membership_does_not_invent_starting_ancestry(self):
        order = capture.RangeOrder(2, 3)
        first = order.accept(result(2), {'previous': position(1)['block_id']}); self.assertEqual(first['blockNum'], 2)
        order.accept(result(3), {'previous': position(2)['block_id']}); order.finish(); self.assertEqual(order.first_previous, (1, position(1)['block_id']))
        unknown = capture.RangeOrder(2, 2); payload = result(2); payload['prev_block'] = None
        unknown.accept(payload, {'previous': position(1)['block_id']}); unknown.finish(); self.assertIsNone(unknown.first_previous)

    def test_duplicate_missing_parent_reversible_and_incomplete_ranges_reject(self):
        cases = [(result(3), {'previous': position(2)['block_id']}), (result(2), {'previous': 'f' * 64}),
                 ({**result(2), 'last_irreversible': position(2)}, {'previous': position(1)['block_id']})]
        for payload, block in cases:
            with self.assertRaises(capture.CaptureError):
                capture.RangeOrder(2, 3).accept(payload, block)
        order = capture.RangeOrder(2, 3); order.accept(result(2), {'previous': position(1)['block_id']})
        with self.assertRaises(capture.CaptureError):
            order.accept(result(2), {'previous': position(1)['block_id']})
        with self.assertRaises(capture.CaptureError):
            order.finish()

    def test_status_requires_chain_irreversibility_and_retention_for_both_streams(self):
        status = ['get_status_result_v0', {'chain_id': '1' * 64, 'last_irreversible': position(20), 'trace_begin_block': 1,
                  'trace_end_block': 21, 'chain_state_begin_block': 1, 'chain_state_end_block': 21}]
        capture.verify_status(status, pins(), 2, 20)
        for key, value in [('chain_id', '0' * 64), ('trace_begin_block', 3), ('chain_state_end_block', 20), ('last_irreversible', position(19))]:
            changed = copy.deepcopy(status); changed[1][key] = value
            with self.assertRaises(capture.CaptureError):
                capture.verify_status(changed, pins(), 2, 20)

    def test_official_oracle_keeps_raw_failure_even_when_clio_exits_zero(self):
        output = MemoryOutput()
        oracle = capture.Oracle(pins(), output, capture.Deadline(10), capture.DEFAULT_LIMITS,
                                runner=lambda *_: (0, b'', b'ERROR: Unable to convert the packed hex'))
        with self.assertRaises(capture.CaptureError):
            oracle.decode('result', b'\x00')
        self.assertEqual(oracle.commands[0]['exitCode'], 0)
        self.assertEqual(output.files['oracle/00001-stderr.bin'], b'ERROR: Unable to convert the packed hex')

    def test_timeout_oracle_preserves_partial_stdout_stderr_and_actual_failure(self):
        def failed(*_):
            raise capture.CommandFailure('deadline', -9, b'partial', b'warning')
        output = MemoryOutput(); oracle = capture.Oracle(pins(), output, capture.Deadline(10), capture.DEFAULT_LIMITS, runner=failed)
        with self.assertRaises(capture.CaptureError):
            oracle.decode('result', b'\x00')
        self.assertEqual(output.files['oracle/00001-stdout.bin'], b'partial')
        self.assertEqual(oracle.commands[0]['exitCode'], -9); self.assertFalse(oracle.commands[0]['outputComplete'])

    def test_large_raw_source_never_launches_invalid_argv_or_fabricates_oracle(self):
        def forbidden(*_):
            self.fail('oversized literal reached clio runner')
        oracle = capture.Oracle(pins(), MemoryOutput(), capture.Deadline(10), capture.DEFAULT_LIMITS, runner=forbidden)
        with self.assertRaisesRegex(capture.CaptureError, 'raw input retained'):
            oracle.decode('result', b'x' * (capture.ORACLE_INPUT_LIMIT + 1))
        self.assertEqual(oracle.commands, [])
        self.assertEqual(oracle.exclusions[0]['reason'], 'literal-argv-limit')


class ControlledPipelineTests(unittest.TestCase):
    """Production capture orchestration, controlled process/HTTP/socket/oracle; no live qualification."""
    def run_capture(self, mode):
        selected = pins(); genesis = b'public controlled genesis'; schema = b'{"version":"sysio::abi/1.1"}'
        selected['genesis']['sha256'] = capture.sha(genesis); selected['handshakeSha256'] = capture.sha(schema)
        artifact = MemoryOutput(); artifact.data = artifact.files; artifact.files = []

        def write(name, data, final=False):
            if name in artifact.data:
                raise AssertionError('overwrite')
            artifact.data[name] = data
            record = {'file': name, 'bytes': len(data), 'sha256': capture.sha(data)}; artifact.files.append(record)
            return record
        artifact.write = write
        frames = [b'F2', b'F2' if mode == 'duplicate' else b'F3']
        if mode == 'oversized':
            frames = [b'X' * (capture.ORACLE_INPUT_LIMIT + 1)]

        class Peer(FakeSocket):
            def __init__(self):
                super().__init__(b''); self.closed, self.acks = False, 0

            def recv(self, size):
                if mode == 'partial-timeout' and not self.data:
                    raise TimeoutError('controlled partial range frame timeout')
                return super().recv(size)

            def sendall(self, data):
                self.sent.append(data)
                if data.startswith(b'GET '):
                    key = data.split(b'Sec-WebSocket-Key: ', 1)[1].split(b'\r\n', 1)[0]
                    accept = capture.base64.b64encode(capture.hashlib.sha1(key + b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
                    self.data += b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive,Upgrade\r\nSec-WebSocket-Accept: ' + accept + b'\r\n\r\n' + frame(schema, 1)
                    return
                length, offset = data[1] & 127, 2
                if length == 126:
                    length, offset = struct.unpack('>H', data[2:4])[0], 4
                mask = data[offset:offset + 4]; body = bytes(value ^ mask[index % 4] for index, value in enumerate(data[offset + 4:]))
                if body == b'\x00':
                    self.data += frame(b'S')
                elif body == b'R':
                    if mode == 'partial-eof':
                        self.data += b'\x82\x0aabc'
                    elif mode == 'partial-timeout':
                        self.data += frame(b'F', final=False) + b'\x80\x04x'
                    elif mode == 'noncanonical-126':
                        self.data += b'\x82\x7e\x00\x01'
                    elif mode == 'noncanonical-127':
                        self.data += b'\x82\x7f' + struct.pack('>Q', 65535)
                    else:
                        self.data += frame(frames.pop(0))
                elif body == b'\x02\x01\x00\x00\x00':
                    # Every source and oracle artifact must exist before one credit is returned.
                    if not any(name.endswith('-deltas-oracle.json') for name in artifact.data):
                        raise AssertionError('ACK preceded durable source/oracle boundary')
                    self.acks += 1
                    if frames:
                        self.data += frame(frames.pop(0))

            def close(self):
                self.closed = True

        peer = Peer()
        status = ['get_status_result_v0', {'chain_id': '1' * 64, 'last_irreversible': position(20), 'trace_begin_block': 1,
                  'trace_end_block': 21, 'chain_state_begin_block': 1, 'chain_state_end_block': 21}]

        def runner(arguments, *_):
            if arguments[1:] == ['version', 'client']:
                return 0, b'v1.0.0\n', b''
            if arguments[2] == 'pack_hex':
                name = Path(arguments[3]).name
                value = {'status.json': '00', 'range.json': '52', 'ack.json': '0201000000'}[name]
            else:
                body, type_name = bytes.fromhex(arguments[3]), arguments[5]
                if body == b'S':
                    value = status
                elif body.startswith(b'F'):
                    number = int(body[1:]); value = ['get_blocks_result_v0', {**result(number), 'block': (b'B' + body[1:]).hex(),
                         'traces': (b'T' + body[1:]).hex(), 'deltas': (b'D' + body[1:]).hex()}]
                elif type_name == 'signed_block':
                    value = {'previous': position(int(body[1:]) - 1)['block_id']}
                else:
                    value = []
            return 0, capture.json_bytes(value), b''

        proof = {'controlled': True}
        info = {'chain_id': selected['chainId'], 'last_irreversible_block_num': 20}
        with patch.object(capture, 'process_provenance', return_value=proof), patch.object(capture, 'executable_hash', return_value=selected['clio']['sha256']), \
             patch.object(capture, 'regular_bytes', return_value=genesis), patch.object(capture, 'chain_info', return_value=(capture.json_bytes(info), info)), \
             patch.object(capture, 'run_bounded', side_effect=runner), patch.object(capture, 'Output', return_value=artifact), \
             patch.object(capture.TimedSocket, 'connect_to', return_value=peer):
            # Oracle's default function binding is intentionally explicit in the controlled fixture.
            original_oracle = capture.Oracle
            with patch.object(capture, 'Oracle', side_effect=lambda p, o, d, l: original_oracle(p, o, d, l, runner=runner)):
                outcome = capture.capture(capture.json_bytes(selected), '/owned/new-output', 2, 3)
        return outcome, artifact.data, peer

    def test_contiguous_range_keeps_requests_ack_raw_wire_and_incomplete_frontier(self):
        value, files, peer = self.run_capture('positive')
        self.assertEqual(value['status'], 'captured'); self.assertTrue(value['range']['complete']); self.assertEqual(peer.acks, 2); self.assertTrue(peer.closed)
        self.assertEqual([row['blockNum'] for row in value['blocks']], [2, 3])
        self.assertEqual(files['blocks/00000-result.bin'], b'F2'); self.assertIn('manifest.json', files)
        self.assertEqual(value['initialAncestry']['abiFrontier'], 'not-supplied'); self.assertFalse(value['deltaFraming']['fullOracleConsumptionVerified'])
        self.assertEqual(value['qualification']['status'], 'incomplete'); self.assertFalse(value['qualification']['selectedTestnet'])

    def test_duplicate_result_retains_raw_then_closes_without_second_credit(self):
        value, files, peer = self.run_capture('duplicate')
        self.assertEqual(value['status'], 'incomplete'); self.assertFalse(value['range']['complete']); self.assertEqual(peer.acks, 1); self.assertTrue(peer.closed)
        self.assertEqual(files['blocks/00001-result.bin'], b'F2'); self.assertIn('out-of-order', value['error']['message'])

    def test_oversized_source_is_retained_without_oracle_or_credit(self):
        value, files, peer = self.run_capture('oversized')
        self.assertEqual(value['status'], 'incomplete'); self.assertTrue(peer.closed); self.assertEqual(peer.acks, 0)
        self.assertEqual(len(files['blocks/00000-result.bin']), capture.ORACLE_INPUT_LIMIT + 1)
        self.assertEqual(value['oracleExclusions'][0]['reason'], 'literal-argv-limit'); self.assertIn('manifest.json', files)

    def test_partial_range_eof_or_timeout_closes_socket_preserves_manifest_and_returns_no_credit(self):
        for mode, partial in [('partial-eof', b'\x82\x0aabc'), ('partial-timeout', b'\x80\x04x'),
                              ('noncanonical-126', b'\x82\x7e\x00\x01'),
                              ('noncanonical-127', b'\x82\x7f' + struct.pack('>Q', 65535))]:
            with self.subTest(mode=mode):
                value, files, peer = self.run_capture(mode)
                self.assertEqual(value['status'], 'incomplete'); self.assertFalse(value['range']['complete'])
                self.assertTrue(peer.closed); self.assertEqual(peer.acks, 0); self.assertEqual(value['blocks'], [])
                self.assertIn('manifest.json', files); self.assertNotIn('blocks/00000-result.bin', files)
                observed = [row for row in value['transport'] if row['direction'] == 'in' and not row['complete']]
                self.assertEqual(len(observed), 1); self.assertEqual(files[observed[0]['file']], partial)
                self.assertEqual(value['error']['type'], 'TimeoutError' if mode == 'partial-timeout' else 'CaptureError')


if __name__ == '__main__':
    unittest.main()
