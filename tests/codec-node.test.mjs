import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {toJson} from '@bufbuild/protobuf';
import {AnySchema, DurationSchema, FileDescriptorProtoSchema, TimestampSchema} from '@bufbuild/protobuf/wkt';
import {
  WireCodecError, createWireDeploymentRegistry, createWireShipCodec, createWireValueCodec,
  decodeWireAbi, encodeWireAbi, resolveCodecProfile,
} from '../dist/index.js';
import {normalizeAbiOracle, normalizeOracle} from '../scripts/codec-oracle.mjs';

const fixtureRoot = new URL('../fixtures/codec/', import.meta.url);
const read = name => JSON.parse(fs.readFileSync(new URL(name, fixtureRoot), 'utf8'));
const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const base = {version: 'sysio::abi/1.3', types: [], structs: [], actions: [], tables: [], ricardian_clauses: [], error_messages: [], abi_extensions: []};
const make = extra => ({...base, ...extra});
const codec = createWireValueCodec(base);
const rejects = (action, code = 'invalid_value') => assert.throws(action, error => error instanceof WireCodecError && error.code === code);

for (const name of ['oracle-vectors.json', 'source-vectors.json', 'ship-vectors.json', 'crypto-vectors.json']) {
  for (const vector of read(name).vectors) {
    test(`${name}: ${vector.id}`, () => {
      const profile = resolveCodecProfile(vector.profileId);
      if (vector.operation === 'decodeAbi') {
        const actual = decodeWireAbi(bytes(vector.hex), profile);
        const expected = normalizeAbiOracle(vector.expected);
        // The binary API retains a present empty descriptor string; the node's JSON printer omits it.
        if (actual.protobuf_types === '' && !Object.hasOwn(expected, 'protobuf_types')) expected.protobuf_types = '';
        const comparable = structuredClone(actual);
        if (comparable.protobuf_types && typeof expected.protobuf_types === 'object') comparable.protobuf_types = JSON.parse(comparable.protobuf_types);
        assert.deepEqual(comparable, expected);
        assert.equal(hex(encodeWireAbi(actual, profile)), vector.hex, 'Binary metadata and descriptor formatting round-trip exactly');
      } else {
        const abi = vector.abiPath ? read(vector.abiPath) : vector.abi ?? base;
        if (vector.id === 'captured-ship-deltas') {
          // Both pinned nodes advertise three streams but emit four when the
          // shared resource index changes. clio ignores the final 109 bytes.
          // A generic codec must reject this; the profile's SHiP adapter owns
          // any explicit, separately reported correction.
          rejects(() => createWireValueCodec(abi, profile).decode(vector.typeName, bytes(vector.hex)));
          return;
        }
        const actual = createWireValueCodec(abi, profile).decode(vector.typeName, bytes(vector.hex));
        assert.deepEqual(actual, normalizeOracle(vector.expected, vector.typeName, abi));
        if (name === 'crypto-vectors.json') assert.equal(hex(createWireValueCodec(abi, profile).encode(vector.typeName, actual)), vector.hex, 'Independent crypto carrier re-encodes the complete variant and pointer framing');
      }
    });
  }
}

test('meta-ABI preserves table ID zero, secondary IDs, arbitrary extensions and raw protobuf JSON', () => {
  const abi = make({
    structs: [{name: 'row', base: '', fields: [{name: 'id', type: 'uint64'}]}],
    tables: [{name: 'arbitrary-table-text', index_type: 'i64', key_names: ['id'], key_types: ['uint64'], type: 'row', table_id: 0, secondary_indexes: [{name: 'by_id', key_type: 'uint64', table_id: 65535}]}],
    abi_extensions: [[49374, '00ff0100']], variants: [], action_results: [], enums: [],
    protobuf_types: '{ "file" : [] }',
  });
  const actual = decodeWireAbi(encodeWireAbi(abi));
  assert.equal(actual.tables[0].table_id, 0);
  assert.equal(actual.tables[0].secondary_indexes[0].table_id, 65535);
  assert.deepEqual(actual.abi_extensions, abi.abi_extensions);
  assert.equal(actual.protobuf_types, abi.protobuf_types);
  const unordered = {protobuf_types: {'\u{10000}': 4, '\u20ac': 3, '\u00e9': 2, file: [], 2: 2, 10: 10}};
  assert.equal(decodeWireAbi(encodeWireAbi({...base, ...unordered})).protobuf_types, '{"10":10,"2":2,"file":[],"é":2,"€":3,"𐀀":4}');
});

test('meta-ABI omits absent optional tails and rejects unknown mandatory layouts or trailing data', () => {
  const encoded = encodeWireAbi(base);
  assert.equal(Object.hasOwn(decodeWireAbi(encoded), 'variants'), false);
  rejects(() => decodeWireAbi(encoded.subarray(0, -1)), 'invalid_abi');
  rejects(() => decodeWireAbi(Uint8Array.from([...encodeWireAbi(make({variants: [], action_results: [], enums: [], protobuf_types: ''})), 0])), 'unsupported_feature');
  rejects(() => encodeWireAbi({...base, future_required_layout: []}), 'unsupported_feature');
  rejects(() => encodeWireAbi({...base, version: 'eosio::abi/1.2'}), 'unsupported_feature');
  rejects(() => encodeWireAbi({...base, version: 'sysio::abi/1.999'}), 'unsupported_feature');
  rejects(() => encodeWireAbi(make({tables: [{name: 'bad', type: 'uint8', table_id: 65536}]})), 'invalid_abi');
  rejects(() => encodeWireAbi(make({enums: [{name: 'E', type: 'uint8', values: [{name: 'X', value: '9223372036854775808'}]}]})), 'invalid_abi');
});

test('typed structure traversal handles inheritance, aliases, arrays, fixed arrays, optional and binary extensions', () => {
  const abi = make({
    types: [{new_type_name: 'counter', type: 'uint64'}, {new_type_name: 'pair_alias', type: 'pair'}],
    structs: [
      {name: 'parent', base: '', fields: [{name: 'id', type: 'counter'}]},
      {name: 'pair', base: 'parent', fields: [{name: 'values', type: 'int16[2]'}, {name: 'timestamps', type: 'block_timestamp_type[]'}, {name: 'note', type: 'string?'}, {name: 'extra', type: 'uint32$'}]},
    ],
    variants: [{name: 'choice', types: ['pair_alias', 'string']}],
  });
  const valueCodec = createWireValueCodec(abi);
  const value = ['pair_alias', {id: '18446744073709551615', values: [-32768, 32767], timestamps: ['2025-01-01T00:00:00.000', '2025-01-01T00:00:00.500'], note: null}];
  assert.deepEqual(valueCodec.decode('choice', valueCodec.encode('choice', value)), value);
  const complete = {...value[1], extra: 42};
  assert.deepEqual(valueCodec.decode('pair', valueCodec.encode('pair', complete)), complete);
  rejects(() => valueCodec.encode('pair[]', [value[1]]));
  rejects(() => valueCodec.encode('pair', {...value[1], unexpected: 1}));
  rejects(() => valueCodec.encode('pair', {...value[1], values: [1]}));
  rejects(() => valueCodec.decode('choice', bytes('02')));
  assert.deepEqual(createWireValueCodec(make({structs: [{name: 'empty', base: '', fields: []}]})).decode('empty', bytes('')), {});
});

test('enum names, unique suffixes, numeric fallbacks and wide integer boundaries stay lossless', () => {
  const valueCodec = createWireValueCodec(make({enums: [
    {name: 'State', type: 'int32', values: [{name: 'STATE_ACTIVE', value: 1}, {name: 'OTHER_ACTIVE', value: 2}, {name: 'STATE_CLOSED', value: -1}]},
    {name: 'Wide', type: 'uint128', values: [{name: 'WIDE_KNOWN', value: '9223372036854775807'}]},
  ]}));
  assert.equal(valueCodec.decode('State', valueCodec.encode('State', 'CLOSED')), 'STATE_CLOSED');
  assert.equal(valueCodec.decode('State', valueCodec.encode('State', 'STATE_ACTIVE')), 'STATE_ACTIVE');
  assert.equal(valueCodec.decode('State', valueCodec.encode('State', 37)), 37);
  rejects(() => valueCodec.encode('State', 'ACTIVE'));
  for (const [type, value] of [['uint64', '18446744073709551615'], ['int64', '-9223372036854775808'], ['uint128', '340282366920938463463374607431768211455'], ['int128', '-170141183460469231731687303715884105728']]) {
    assert.equal(valueCodec.decode(type, valueCodec.encode(type, value)), value);
  }
  const unknown = '340282366920938463463374607431768211455';
  assert.equal(valueCodec.decode('Wide', valueCodec.encode('Wide', unknown)), unknown);
  rejects(() => valueCodec.encode('uint64', 9007199254740992));
  rejects(() => createWireValueCodec(make({enums: [{name: 'Bad', type: 'string', values: []}]})), 'invalid_abi');
  rejects(() => createWireValueCodec(make({enums: [{name: 'Bad', type: 'uint8', values: [{name: 'X', value: 256}]}]})), 'invalid_abi');
  rejects(() => createWireValueCodec(make({enums: [{name: 'Bad', type: 'uint8', values: [{name: 'X', value: 1}, {name: 'Y', value: 1}]}]})), 'invalid_abi');
});

test('slug builtin is revision-specific, raw noncanonical slugs retain total node rendering', () => {
  assert.equal(codec.decode('slug_name', codec.encode('slug_name', 'WIRE_123')), 'WIRE_123');
  assert.equal(codec.decode('slug_name', codec.encode('slug_name', {value: (1n << 63n | 23373212024832n).toString()})), 'ETH');
  assert.equal(codec.decode('slug_name', codec.encode('slug_name', {value: '167125767421952'})), '\0');
  assert.equal(codec.decode('slug_name', bytes('0100000000000000')), '');
  rejects(() => codec.encode('slug_name', '7ETH'));
  const old = createWireValueCodec(read('artifacts/7dede884/sysio.chains.abi'), resolveCodecProfile('wire-sysio-7dede884-engineering-v1'));
  assert.deepEqual(old.decode('slug_name', bytes('0000000080140000')), {value: '22539988369408'});
  rejects(() => createWireValueCodec(base, {...resolveCodecProfile(), epochMilliseconds: 0}), 'unsupported_feature');
});

test('scalar leaves preserve numeric bools, Wire fixed varint aliases, bitsets and BOM strings', () => {
  assert.equal(codec.decode('bool', bytes('ff')), 255);
  assert.equal(hex(codec.encode('varint_int64', '-1')), 'ffffffffffffffff');
  assert.equal(hex(codec.encode('varint_uint64', '1')), '0100000000000000');
  assert.equal(codec.decode('varint32', codec.encode('varint32', -2147483648)), -2147483648);
  assert.equal(codec.decode('varuint32', codec.encode('varuint32', 4294967295)), 4294967295);
  assert.equal(codec.decode('bitset', codec.encode('bitset', '101000001')), '101000001');
  assert.equal(codec.decode('string', codec.encode('string', '\ufeffhello 🌐')), '\ufeffhello 🌐');
  assert.equal(codec.decode('float64', bytes('0000000000000080')), '-0.00000000000000000');
  assert.equal(codec.decode('float64', bytes('000000000000f07f')), 'inf');
  assert.equal(codec.decode('float64', bytes('000000000000f87f')), 'nan');
  const wideFloat = codec.decode('float64', codec.encode('float64', '1e30'));
  assert.equal(wideFloat, '1000000000000000019884624838656.00000000000000000');
  assert.equal(codec.decode('float128', bytes('00112233445566778899aabbccddeeff')), '0x00112233445566778899aabbccddeeff');
  assert.equal(codec.decode('time_point', bytes('ffffffffffffffff')), '-000000.000001');
  assert.equal(codec.decode('time_point', bytes('c0bdf0ffffffffff')), '-000001');
  const negativeHour = Buffer.alloc(8); negativeHour.writeBigInt64LE(-3_600_000_000n);
  assert.equal(codec.decode('time_point', negativeHour), '-010000');
  rejects(() => codec.encode('time_point', '1969-12-31T23:59:59.999'), 'unsupported_feature');
  assert.deepEqual(codec.decode('extended_asset', codec.encode('extended_asset', {quantity: '-10.0000 SYS', contract: 'sysio.token'})), {quantity: '-10.0000 SYS', contract: 'sysio.token'});
});

test('protobuf checks both frames, uses snake field names and retains Google JSON scalar rules', () => {
  const valueCodec = createWireValueCodec(read('artifacts/6508c9e8/proto_abi_test.abi'));
  const payload = {value: 99, str_value: 'snake_case'};
  const encoded = valueCodec.encode('protobuf::test.ActResult', payload);
  assert.deepEqual(valueCodec.decode('protobuf::test.ActResult', encoded), payload);
  assert.deepEqual(valueCodec.decode('protobuf::test.ActData', bytes('0100')), {});
  for (const bad of ['00', '0101', '020000', '020108', '030108', '03010801ff', '808080808000']) rejects(() => valueCodec.decode('protobuf::test.ActData', bytes(bad)));
  rejects(() => createWireValueCodec({...base, protobuf_types: '{invalid'}), 'invalid_abi');
  rejects(() => createWireValueCodec(base).decode('protobuf::test.Missing', bytes('0100')), 'unsupported_feature');
  const schema = make({protobuf_types: {file: [{name: 'values.proto', package: 'values', syntax: 'proto3', enumType: [{name: 'State', value: [{name: 'ZERO', number: 0}, {name: 'ONE', number: 1}]}], messageType: [{name: 'Record', field: [
    {name: 'wide_value', number: 1, label: 'LABEL_OPTIONAL', type: 'TYPE_UINT64'},
    {name: 'state_value', number: 2, label: 'LABEL_OPTIONAL', type: 'TYPE_ENUM', typeName: '.values.State'},
    {name: 'raw_data', number: 3, label: 'LABEL_OPTIONAL', type: 'TYPE_BYTES'},
    {name: 'float_value', number: 4, label: 'LABEL_OPTIONAL', type: 'TYPE_DOUBLE'},
  ]}]}]}});
  const rich = createWireValueCodec(schema);
  const value = {wide_value: '18446744073709551615', state_value: 'ONE', raw_data: 'AP8=', float_value: 'Infinity'};
  assert.deepEqual(rich.decode('protobuf::values.Record', rich.encode('protobuf::values.Record', value)), value);
});

test('protobuf Google JSON handles map entries, oneofs, explicit JSON names and well-known values', () => {
  const files = [TimestampSchema, DurationSchema, AnySchema].map(schema => toJson(FileDescriptorProtoSchema, schema.file.proto));
  const schema = make({protobuf_types: {file: [...files, {name: 'rich.proto', package: 'rich', syntax: 'proto3', dependency: files.map(file => file.name), messageType: [{name: 'Record', oneofDecl: [{name: 'choice'}], nestedType: [{name: 'LabelsEntry', options: {mapEntry: true}, field: [
    {name: 'key', number: 1, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING'},
    {name: 'value', number: 2, label: 'LABEL_OPTIONAL', type: 'TYPE_UINT64'},
  ]}], field: [
    {name: 'labels_by_name', number: 1, label: 'LABEL_REPEATED', type: 'TYPE_MESSAGE', typeName: '.rich.Record.LabelsEntry'},
    {name: 'created_at', number: 2, label: 'LABEL_OPTIONAL', type: 'TYPE_MESSAGE', typeName: '.google.protobuf.Timestamp'},
    {name: 'elapsed_time', number: 3, label: 'LABEL_OPTIONAL', type: 'TYPE_MESSAGE', typeName: '.google.protobuf.Duration'},
    {name: 'chosen_name', jsonName: 'customAlias', number: 4, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING', oneofIndex: 0},
    {name: 'chosen_number', number: 5, label: 'LABEL_OPTIONAL', type: 'TYPE_INT32', oneofIndex: 0},
    {name: 'detail_value', number: 6, label: 'LABEL_OPTIONAL', type: 'TYPE_MESSAGE', typeName: '.google.protobuf.Any'},
  ]}]}]}});
  const rich = createWireValueCodec(schema);
  const input = {labels_by_name: {first: '18446744073709551615'}, created_at: '2025-01-01T00:00:00.125Z', elapsed_time: '1.250s', customAlias: 'selected', detail_value: {'@type': 'type.googleapis.com/google.protobuf.Duration', value: '2.500s'}};
  const expected = {...input, chosen_name: input.customAlias}; delete expected.customAlias;
  assert.deepEqual(rich.decode('protobuf::rich.Record', rich.encode('protobuf::rich.Record', input)), expected);
  rejects(() => rich.encode('protobuf::rich.Record', {chosen_name: 'a', chosen_number: 1}));
});

test('protobuf allocation preflight rejects oversized collections, merged segments and Any before the parser runs', () => {
  // Substitute only the expensive value parser in an isolated real Node process.
  // The production descriptor loader, framing, preflight and rejection path run unchanged.
  const probe = `
    import assert from 'node:assert/strict';
    import {registerHooks} from 'node:module';
    import {create,toJson} from '@bufbuild/protobuf';
    import {AnySchema,FileDescriptorProtoSchema} from '@bufbuild/protobuf/wkt';
    const actual = import.meta.resolve('@bufbuild/protobuf');
    let parserCalls = 0, cheapParser = false; globalThis.__wireParserCalled = schema => {parserCalls++; if(cheapParser)return create(schema); throw Error('PARSER_INVOKED_BEFORE_LIMIT');};
    registerHooks({resolve(specifier, context, next) {
      if (specifier === '@bufbuild/protobuf' && context.parentURL.endsWith('/dist/codec/values.js')) return {url:'wire-parser-guard:fixture',shortCircuit:true};
      return next(specifier,context);
    },load(url,context,next) {
      if (url === 'wire-parser-guard:fixture') return {format:'module',shortCircuit:true,source:
        'export * from '+JSON.stringify(actual)+'; export function fromBinary(schema) { return globalThis.__wireParserCalled(schema); }'};
      return next(url,context);
    }});
    const {createWireValueCodec,WireCodecError} = await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
    const optional='LABEL_OPTIONAL', repeated='LABEL_REPEATED';
    const f=(name,number,label,type,extra={})=>({name,number,label,type,...extra});
    const declarations=[
      {name:'Empty',field:[]},
      {name:'Bag',field:[f('items',1,repeated,'TYPE_MESSAGE',{typeName:'.limits.Empty'})]},
      {name:'Scalars',field:[f('items',1,repeated,'TYPE_UINT32')]},
      {name:'Strings',field:[f('items',1,repeated,'TYPE_STRING')]},
      {name:'Merged',field:[f('child',1,optional,'TYPE_MESSAGE',{typeName:'.limits.Scalars'})]},
      {name:'NestedAny',field:[f('child',1,optional,'TYPE_MESSAGE',{typeName:'.google.protobuf.Any'})]},
      {name:'Recursive',field:[f('child',1,optional,'TYPE_MESSAGE',{typeName:'.limits.Recursive'})]},
      {name:'Maps',nestedType:[{name:'EntriesEntry',options:{mapEntry:true},field:[f('key',1,optional,'TYPE_STRING'),f('value',2,optional,'TYPE_UINT32')]}],field:[f('entries',1,repeated,'TYPE_MESSAGE',{typeName:'.limits.Maps.EntriesEntry'})]},
    ];
    const abi={version:'sysio::abi/1.3',types:[],structs:[],actions:[],tables:[],protobuf_types:{file:[toJson(FileDescriptorProtoSchema,AnySchema.file.proto),{name:'limits.proto',package:'limits',syntax:'proto3',dependency:['google/protobuf/any.proto'],messageType:declarations}]}};
    const codec=createWireValueCodec(abi);
    const v=n=>{const out=[];do{const b=n%128;n=Math.floor(n/128);out.push(b|(n?128:0));}while(n);return Buffer.from(out);};
    const field=(tag,payload)=>Buffer.concat([Buffer.from([tag]),v(payload.length),payload]);
    const framed=payload=>{const inner=Buffer.concat([v(payload.length),payload]);return Buffer.concat([v(inner.length),inner]);};
    const emptyItems=Buffer.alloc(200002);for(let i=0;i<emptyItems.length;i+=2)emptyItems[i]=10;
    const repeatedScalar=Buffer.alloc(100002);for(let i=0;i<repeatedScalar.length;i+=2)repeatedScalar[i]=8;
    const merged=Buffer.concat([field(10,repeatedScalar),field(10,repeatedScalar)]);
    const anyType=field(10,Buffer.from('type.googleapis.com/limits.Bag'));
    const anyValue=field(18,emptyItems);
    const splitAny=Buffer.concat([field(10,anyType),field(10,anyValue)]);
    let recursive=Buffer.alloc(0);for(let i=0;i<70;i++)recursive=field(10,recursive);
    const cases=[['Bag',emptyItems],['Scalars',field(10,Buffer.alloc(100001))],['Merged',merged],['Maps',emptyItems],['NestedAny',splitAny],['Recursive',recursive]];
    for(const [type,payload]of cases)assert.throws(()=>codec.decode('protobuf::limits.'+type,framed(payload)),error=>error instanceof WireCodecError&&error.code==='limits_exceeded',type+' failed before parser');
    assert.throws(()=>codec.decode('protobuf::limits.Bag',framed(Buffer.from([11,12]))),error=>error instanceof WireCodecError&&error.code==='unsupported_feature');
    assert.equal(parserCalls,0);
    const largeString='🌐'.repeat(2*1024*1024);
    assert.throws(()=>codec.encode('protobuf::limits.Strings',{items:[largeString,largeString]}),error=>error instanceof WireCodecError&&error.code==='limits_exceeded');
    assert.equal(parserCalls,0);
    cheapParser=true;
    const perMessage=framed(emptyItems.subarray(0,160000));
    const manyMessages=Buffer.concat([v(13),...Array(13).fill(perMessage)]);
    assert.throws(()=>codec.decode('protobuf::limits.Bag[]',manyMessages),error=>error instanceof WireCodecError&&error.code==='limits_exceeded');
    assert.equal(parserCalls,12,'the thirteenth protobuf field must exhaust the shared outer value budget before parser allocation');
    console.log('protobuf-preflight-before-parser-passed');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {encoding: 'utf8', timeout: 15000});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'protobuf-preflight-before-parser-passed\n');
});

test('all Wire crypto suites retain frame lengths and carrier families without claiming authentication', () => {
  const key = bytes('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  const signature = bytes(`1f${'00'.repeat(64)}`);
  const text = value => [Buffer.byteLength(value), ...Buffer.from(value)];
  const keyFrames = [
    [0, ...key], [1, ...key], [2, ...key, 2, ...text('wire.example')],
    [3, ...key], [4, ...new Array(32).fill(7)], [5, 1, ...new Array(96).fill(0)],
  ];
  const signatureFrames = [
    [0, ...signature], [1, ...signature], [2, ...signature, 3, 1, 2, 3, ...text('{"type":"test"}')],
    [3, ...signature], [4, ...new Array(96).fill(7)], [5, 1, ...new Array(192).fill(0)],
  ];
  const suites = ['K1', 'R1', 'WA', 'EM', 'ED', 'BLS'];
  for (const [kind, frames] of [['public_key', keyFrames], ['signature', signatureFrames]]) for (let tag = 0; tag < frames.length; tag++) {
    const frame = Uint8Array.from(frames[tag]);
    const carrier = codec.decode(kind, frame);
    assert.ok(carrier.startsWith(`${kind === 'public_key' ? 'PUB' : 'SIG'}_${suites[tag]}_`));
    assert.equal(hex(codec.encode(kind, carrier)), hex(frame), `${kind}/${suites[tag]} frame round trip`);
    rejects(() => codec.decode(kind, frame.subarray(0, -1)));
    rejects(() => codec.decode(kind, Uint8Array.from([...frame, 0])));
    rejects(() => codec.encode(kind === 'public_key' ? 'signature' : 'public_key', carrier));
  }
  rejects(() => codec.decode('public_key', bytes('06')), 'unsupported_feature');
  rejects(() => codec.decode('public_key', bytes(`055f${'00'.repeat(95)}`)));
  rejects(() => codec.decode('signature', bytes(`05c101${'00'.repeat(193)}`)));
  rejects(() => codec.decode('public_key', bytes('0500')));
  rejects(() => codec.decode('signature', bytes('0500')));
  rejects(() => codec.decode('public_key', bytes(`0502${'00'.repeat(96)}`)));
  const carrier = codec.decode('public_key', Uint8Array.from(keyFrames[0]));
  rejects(() => codec.encode('public_key', `${carrier.slice(0, -1)}${carrier.endsWith('1') ? '2' : '1'}`));
});

test('malformed, overflowing, huge and cyclic inputs fail within explicit limits', () => {
  for (const bad of ['80', '8000', 'ffffffff10', '808080808000']) rejects(() => codec.decode('varuint32', bytes(bad)));
  rejects(() => codec.decode('string', bytes('02ff')));
  rejects(() => codec.decode('string', bytes('01ff')));
  rejects(() => codec.decode('uint32', bytes('0000000000')));
  rejects(() => codec.decode('uint8?', bytes('02')));
  rejects(() => codec.decode('uint8[]', bytes('a18d06')), 'limits_exceeded');
  rejects(() => codec.decode('uint8[100001]', bytes('')), 'limits_exceeded');
  rejects(() => codec.encode('uint8[]', new Array(100001).fill(0)), 'limits_exceeded');
  rejects(() => codec.decode('bytes', new Uint8Array(16 * 1024 * 1024 + 1)), 'limits_exceeded');
  rejects(() => createWireValueCodec(make({types: [{new_type_name: 'a', type: 'b'}, {new_type_name: 'b', type: 'a'}]})), 'invalid_abi');
  rejects(() => createWireValueCodec(make({structs: [{name: 'a', base: 'b', fields: []}, {name: 'b', base: 'a', fields: []}]})), 'invalid_abi');
  rejects(() => createWireValueCodec(make({structs: [{name: 'bad', base: '', fields: [{name: 'x', type: 'uint8$'}, {name: 'y', type: 'uint8'}]}]})), 'invalid_abi');
  const recursive = createWireValueCodec(make({structs: [{name: 'node', base: '', fields: [{name: 'next', type: 'node?'}]}]}));
  rejects(() => recursive.decode('node', Uint8Array.from([...new Array(100).fill(1), 0])), 'limits_exceeded');
});

test('validation never invokes untrusted field getters', () => {
  let called = 0;
  const object = {};
  Object.defineProperty(object, 'x', {enumerable: true, get() {called++; return 1; }});
  rejects(() => createWireValueCodec(make({structs: [{name: 'row', base: '', fields: [{name: 'x', type: 'uint8'}]}]})).encode('row', object));
  const abi = {...base};
  Object.defineProperty(abi, 'version', {enumerable: true, get() {called++; return base.version; }});
  rejects(() => encodeWireAbi(abi), 'invalid_abi');
  assert.equal(called, 0);
});

test('deployment intervals select historical ABI and authoritative primary/secondary zero IDs', () => {
  const abi = make({structs: [{name: 'row', base: '', fields: [{name: 'value', type: 'uint8'}]}], tables: [{name: 'primary', index_type: '', key_names: [], key_types: [], type: 'row', table_id: 0, secondary_indexes: [{name: 'secondary', key_type: 'uint64', table_id: 5}]}]});
  const original = {id: 'old', chainId: '11'.repeat(32), contract: '1', from: {blockNum: 1, ordinal: 0}, until: {blockNum: 5, ordinal: 2}, abiHex: hex(encodeWireAbi(abi)), profileId: resolveCodecProfile().id};
  const changed = {...original, id: 'new', from: {blockNum: 5, ordinal: 2}, until: undefined, abiHex: hex(encodeWireAbi({...abi, tables: [{...abi.tables[0], name: 'renamed'}]}))};
  const registry = createWireDeploymentRegistry([original, changed]);
  const row = {kind: 'contract_row_kv', present: true, code: '1', payer: '2', tableId: 0, keyHex: 'ff0011', valueHex: '2a'};
  const source = {chainId: original.chainId, blockId: '22'.repeat(32), blockNum: 5, ordinal: 1, abiDeployment: 'old'};
  const first = registry.decodeKvRecord(row, source);
  assert.equal(first.tableName, 'primary'); assert.deepEqual(first.value, {value: 42}); assert.equal(first.record.keyHex, row.keyHex);
  const next = registry.decodeKvRecord(row, {...source, ordinal: 2, abiDeployment: 'new'});
  assert.equal(next.tableName, 'renamed'); assert.equal(next.identity, first.identity);
  const index = registry.decodeKvRecord({kind: 'contract_index_kv', present: false, code: '1', payer: '2', tableId: 5, secondaryKeyHex: '0011', primaryKeyHex: 'ff0011'}, source);
  assert.equal(index.secondaryName, 'secondary'); assert.equal(index.primaryTableId, 0); assert.equal(index.record.payer, '2');
  rejects(() => registry.decodeKvRecord(row, {...source, abiDeployment: 'new'}), 'invalid_abi');
  rejects(() => createWireDeploymentRegistry([]).decodeKvRecord(row, source), 'invalid_abi');
  rejects(() => createWireDeploymentRegistry([original, {...original, id: 'overlap'}]).decodeKvRecord(row, source), 'invalid_abi');
  const ambiguous = {...abi, tables: [abi.tables[0], {...abi.tables[0], name: 'collision'}]};
  rejects(() => createWireDeploymentRegistry([{...original, abiHex: hex(encodeWireAbi(ambiguous))}]).decodeKvRecord(row, source), 'invalid_abi');
});

test('captured SHiP transport decodes requests, ACK, raw bundle and nested block/trace/delta bytes', () => {
  const capture = read('ship-capture.json');
  const profile = resolveCodecProfile('wire-sysio-7dede884-engineering-v1');
  const ship = createWireShipCodec(read('ship.abi.json'), profile);
  assert.deepEqual(ship.decodeRequest(bytes('00')), ['get_status_request_v0', {}]);
  assert.equal(hex(ship.encodeRequest(['get_blocks_ack_request_v0', {num_messages: 1}])), capture.ackHex);
  const frame = read('ship-vectors.json').vectors.find(item => item.typeName === 'result' && item.expected[0].startsWith('get_blocks_result_'));
  assert.ok(frame, 'Retained real get_blocks_result frame');
  const bundle = ship.decodeBundle(bytes(frame.hex));
  assert.equal(bundle.profileId, profile.id); assert.equal(bundle.rawFrameHex, frame.hex);
  assert.equal(typeof bundle.block.timestamp, 'string'); assert.ok(bundle.block.timestamp.startsWith('2026-'));
  assert.ok(Array.isArray(bundle.traces)); assert.ok(Array.isArray(bundle.deltas));
  assert.deepEqual(bundle.deltaFraming, {declaredCount: 3, actualCount: 4, compatibility: 'wire-resource-index-count-v1'});
  assert.deepEqual(bundle.deltas.map(delta => delta[1].name), ['account', 'resource_limits', 'resource_usage', 'resource_limits_state']);
  assert.equal(bundle.deltaRows.length, 4);
  assert.deepEqual(ship.decodeResult(bytes(frame.hex)), bundle.envelope);
  rejects(() => ship.decodeBundle(bytes(`${frame.hex}00`)));
});
