import {check, formatAmount, formatAsset, int64Value} from './codec.js';
import {PROJECTION_ID, balanceKey, holdersKind, type TokenProjectionOptions} from './token-projection.js';

/** Structural subsets of the HAPI legacy-route hook and the SDK read ports. */
export interface LegacyStateRequest {
    readonly route: string;
    readonly query: Readonly<Record<string, unknown>>;
    readonly configuredLimit?: number;
}
type Read = {readonly status: 'present'; readonly value: Record<string, any>} | {readonly status: 'covered-absent'};
export interface KeyedReader {get(kind: string, key: string): Promise<Read>}
export interface CompleteKindReader extends KeyedReader {all(kind: string): Promise<readonly {readonly key: string; readonly value: Record<string, any>}[]>}

function window(request: LegacyStateRequest, fallbackLimit: number, fallbackMaximum: number) {
    const number = (value: unknown, fallback: number) => {
        const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^[0-9]{1,9}$/.test(value) ? Number(value) : NaN;
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
    };
    const maximum = request.configuredLimit ?? fallbackMaximum;
    return {skip: number(request.query.skip, 0), limit: Math.min(number(request.query.limit, 0) || fallbackLimit, maximum)};
}
/** Legacy clients do arithmetic on `amount`; `balance` keeps the exact asset text alongside it. */
function legacyAmount(amount: bigint, precision: number): number {
    return Number(formatAmount(amount, precision));
}

export function tokenRoutes(options: TokenProjectionOptions) {
    const ranked = new Set(options.ranked.map(item => holdersKind(item.contract, item.symbol)));
    return {
        get_tokens: {projectionId: PROJECTION_ID, read: 'keyed' as const,
            compose: async (reader: KeyedReader, request: LegacyStateRequest) => {
                const account = String(request.query.account ?? '');
                const {skip, limit} = window(request, 50, 100);
                const holdings = await reader.get('holdings', account);
                const tokens = [];
                if (holdings.status === 'present') for (const {contract, symbol} of holdings.value.tokens.slice(skip, skip + limit)) {
                    const row = await reader.get('balance', balanceKey(contract, account, symbol));
                    check(row.status === 'present', 'Holdings list a balance that is absent');
                    const amount = int64Value(row.value.amount), precision = row.value.precision as number;
                    tokens.push({symbol, precision, amount: legacyAmount(amount, precision), contract,
                        balance: formatAsset(amount, precision, symbol)});
                }
                return {account, tokens};
            }},
        get_top_holders: {projectionId: PROJECTION_ID, read: 'complete-kind' as const,
            validate: (request: LegacyStateRequest) => {
                const {contract, symbol} = request.query;
                if (typeof contract !== 'string' || !options.contracts.includes(contract))
                    return `Token holders are projected only for ${options.contracts.join(', ')}`;
                if (typeof symbol !== 'string' || !symbol) return 'symbol is required';
                if (!ranked.has(holdersKind(contract, symbol))) return `Holders of ${symbol} on ${contract} are not ranked by this provider`;
                return undefined;
            },
            compose: async (reader: CompleteKindReader, request: LegacyStateRequest) => {
                const contract = request.query.contract as string, symbol = request.query.symbol as string;
                const {skip, limit} = window(request, 50, 500);
                const rows = (await reader.all(holdersKind(contract, symbol))).map(row => ({owner: row.key,
                    amount: int64Value(row.value.amount), precision: row.value.precision as number, block_num: row.value.block_num as number}));
                // Largest first; equal amounts by owner, so pages are stable.
                rows.sort((a, b) => a.amount === b.amount ? (a.owner < b.owner ? -1 : 1) : a.amount > b.amount ? -1 : 1);
                return {contract, symbol, holders: rows.slice(skip, skip + limit).map(row => ({owner: row.owner,
                    amount: legacyAmount(row.amount, row.precision), symbol, updated_on: row.block_num,
                    balance: formatAsset(row.amount, row.precision, symbol)}))};
            }},
    };
}
