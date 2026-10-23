/** Source-pinned engineering profiles. None is a final launch selection. */
export interface WireCodecProfile {
  readonly id: string;
  readonly upstreamRevision: string;
  readonly epochMilliseconds: number;
  readonly slotMilliseconds: number;
  readonly slugNameBuiltin: boolean;
}

/** Native source handling requires an explicit, separately admitted profile. */
export const nativeActionProfileId = 'wire-sysio-6508c9e8-native-engineering-v1';

export const codecProfiles: readonly WireCodecProfile[] = Object.freeze([
  Object.freeze({
    id: 'wire-sysio-6508c9e8-engineering-v1',
    upstreamRevision: '6508c9e8f4044df8d5acb082a7af3be6a80cd9a0',
    epochMilliseconds: 1735689600000,
    slotMilliseconds: 500,
    slugNameBuiltin: true,
  }),
  Object.freeze({
    id: 'wire-sysio-7dede884-engineering-v1',
    upstreamRevision: '7dede884e0150d36fa788e85a119e10653ade8ca',
    epochMilliseconds: 1735689600000,
    slotMilliseconds: 500,
    slugNameBuiltin: false,
  }),
  Object.freeze({
    id: nativeActionProfileId,
    upstreamRevision: '6508c9e8f4044df8d5acb082a7af3be6a80cd9a0',
    epochMilliseconds: 1735689600000,
    slotMilliseconds: 500,
    slugNameBuiltin: true,
  }),
]);

export function resolveCodecProfile(id?: string): WireCodecProfile {
  const profile = codecProfiles.find((entry) => entry.id === (id ?? codecProfiles[0]!.id));
  if (!profile) throw new RangeError('Unknown Wire codec profile');
  return profile;
}
