import {readFileSync} from 'node:fs';

export const corpus = JSON.parse(readFileSync(new URL('../fixtures/wire-testnet-token-rows.json', import.meta.url), 'utf8'));
export const ABI = Object.fromEntries(corpus.rows.map(row => [row.contract, row.abiSha256]));

const CHARMAP = '.12345abcdefghijklmnopqrstuvwxyz';
export function nameValue(name) {
    let value = 0n;
    for (let i = 0; i < 13; i++) {
        const index = i < name.length ? BigInt(CHARMAP.indexOf(name[i])) : 0n;
        value |= i === 12 ? index & 0x0fn : (index & 0x1fn) << BigInt(59 - 5 * i);
    }
    return value;
}
export const symbolValue = symbol => [...symbol].reduceRight((value, char) => (value << 8n) | BigInt(char.charCodeAt(0)), 0n);
const be = value => value.toString(16).padStart(16, '0');
export const accountsKey = (owner, symbol) => be(nameValue(owner)) + be(symbolValue(symbol));
export const scopedStatKey = symbol => be(symbolValue(symbol)) + be(symbolValue(symbol));
export const unscopedStatKey = symbol => be(symbolValue(symbol));

/** Binary asset as Wire stores it: int64 little-endian amount, a precision byte, then the code padded to seven bytes. */
export function assetText(hex) {
    const bytes = Buffer.from(hex, 'hex'), amount = bytes.readBigInt64LE(0), precision = bytes[8];
    const code = bytes.subarray(9, 16).toString('latin1').replace(/\0+$/, '');
    const digits = (amount < 0n ? -amount : amount).toString().padStart(precision + 1, '0');
    return `${amount < 0n ? '-' : ''}${precision ? digits.slice(0, -precision) + '.' + digits.slice(-precision) : digits} ${code}`;
}

export function tableInput(contract, name, keyHex, present, data, overrides = {}) {
    return {kind: 'table', contract, name, identity: {kind: 'kv-primary', tableId: name === 'accounts' ? 25660 : 4264, keyHex},
        present, data, payer: contract, abiSha256: ABI[contract], ...overrides};
}

const freeze = value => JSON.parse(JSON.stringify(value), (_key, item) => item && typeof item === 'object' ? Object.freeze(item) : item);
/** The SDK reduction port's semantics: reads see this block's own writes, and a failed block leaves no effects. */
export function memoryState() {
    const rows = new Map(), id = (kind, key) => JSON.stringify([kind, key]);
    const read = map => async (kind, key) => {
        const hit = map.get(id(kind, key));
        return hit === undefined || hit === null ? {status: 'covered-absent'} : {status: 'present', value: hit};
    };
    return {
        rows,
        async apply(reduce, inputs, blockNum) {
            const staged = new Map(rows), mutations = [];
            await reduce({source: {block: {blockNum}, inputs}, get: read(staged),
                put: (kind, key, value) => {mutations.push(['put', kind, key]); staged.set(id(kind, key), freeze(value));},
                delete: (kind, key) => {mutations.push(['delete', kind, key]); staged.set(id(kind, key), null);}});
            for (const [key, value] of staged) value === null ? rows.delete(key) : rows.set(key, value);
            return mutations;
        },
        reader: {
            get: read(rows),
            async all(kind) {
                return [...rows].map(([key, value]) => [JSON.parse(key), value]).filter(([[k]]) => k === kind)
                    .map(([[, key], value]) => ({key, value}));
            },
        },
        value(kind, key) {return rows.get(id(kind, key));},
    };
}
