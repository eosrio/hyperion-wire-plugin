export type WireCodecErrorCode = 'invalid_abi' | 'invalid_value' | 'unsupported_feature' | 'limits_exceeded';

export class WireCodecError extends Error {
  constructor(readonly code: WireCodecErrorCode, message: string) {
    super(message);
    this.name = 'WireCodecError';
  }
}

export function codecAssert(condition: unknown, message: string, code: WireCodecErrorCode = 'invalid_value'): asserts condition {
  if (!condition) throw new WireCodecError(code, message);
}
