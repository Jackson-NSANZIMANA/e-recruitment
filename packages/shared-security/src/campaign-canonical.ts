// Campaign-specific canonical JSON and deterministic identifiers (BUILD-001).
// This is separate from canonicalJson(): the older signature format has an
// intentionally different compatibility contract and must not be changed.

import { createHash } from 'node:crypto';

export const CAMPAIGN_POLICY_HASH_VERSION = 1 as const;
export const CAMPAIGN_COVERAGE_HASH_VERSION = 1 as const;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeString(value: string): string {
  // NFC makes canonically-equivalent Unicode input hash identically. JSON
  // stringification below emits the normalized Unicode as UTF-8 with no BOM.
  return value.normalize('NFC');
}

function canonicalSerialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(normalizeString(value));
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}`);
    // ECMAScript JSON number serialization is the specified shortest
    // round-trippable representation; JSON.stringify normalizes -0 to 0.
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(`Non-plain array at ${path}`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`Symbol key at ${path}`);
    }
    const allowedKeys = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
    if (Object.getOwnPropertyNames(value).some((key) => !allowedKeys.has(key))) {
      throw new TypeError(`Non-JSON array property at ${path}`);
    }
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`Sparse or non-JSON array entry at ${path}[${String(index)}]`);
      }
      entries.push(canonicalSerialize(descriptor.value as unknown, `${path}[${String(index)}]`));
    }
    return `[${entries.join(',')}]`;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported JSON value at ${path}`);
  }

  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Non-plain object at ${path}`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`Symbol key at ${path}`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const normalizedEntries: Array<[string, unknown]> = [];
  const normalizedKeys = new Set<string>();
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`Non-JSON property at ${path}.${key}`);
    }
    const normalizedKey = normalizeString(key);
    if (normalizedKeys.has(normalizedKey)) {
      throw new TypeError(`Unicode-normalized key collision at ${path}.${normalizedKey}`);
    }
    normalizedKeys.add(normalizedKey);
    normalizedEntries.push([normalizedKey, descriptor.value as unknown]);
  }
  normalizedEntries.sort(([left], [right]) => compareCodeUnits(left, right));

  return `{${normalizedEntries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalSerialize(entry, `${path}.${key}`)}`)
    .join(',')}}`;
}

/**
 * Canonical campaign JSON v1:
 * - UTF-8 after NFC-normalizing every string and object key;
 * - object keys sort by ascending UTF-16 code-unit order;
 * - arrays retain their supplied order (set-like policy arrays are sorted by
 *   the policy validator before calling this function);
 * - compact JSON.stringify separators (no insignificant whitespace);
 * - null is serialized explicitly; undefined/non-JSON values are rejected;
 * - finite numbers use ECMAScript's shortest round-trip JSON representation,
 *   with negative zero normalized to zero.
 */
export function canonicalCampaignJson(value: unknown): string {
  return canonicalSerialize(value, '$');
}

/** SHA-256 of canonical campaign JSON v1, as lowercase hexadecimal UTF-8. */
export function hashCampaignCanonicalJson(value: unknown): string {
  return createHash('sha256')
    .update(Buffer.from(canonicalCampaignJson(value), 'utf8'))
    .digest('hex');
}

export interface CampaignCoverageSessionValue {
  readonly district: string;
  readonly province: string;
  readonly venueName: string;
  readonly examDate: string;
  readonly reportingTimeHour: number;
  readonly capacityLimit: number | null;
  readonly isActive: boolean;
}

function compareCoverageText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCoverageSessions(
  left: CampaignCoverageSessionValue,
  right: CampaignCoverageSessionValue,
): number {
  return (
    compareCoverageText(left.district, right.district) ||
    compareCoverageText(left.province, right.province) ||
    compareCoverageText(left.examDate, right.examDate) ||
    compareCoverageText(left.venueName, right.venueName) ||
    left.reportingTimeHour - right.reportingTimeHour ||
    (left.capacityLimit === right.capacityLimit
      ? 0
      : left.capacityLimit === null
        ? -1
        : right.capacityLimit === null
          ? 1
          : left.capacityLimit - right.capacityLimit) ||
    Number(left.isActive) - Number(right.isActive)
  );
}

/** Hash a deterministic session set. Mutable registration counts are excluded. */
export function campaignCoverageHash(
  campaignId: string,
  sessions: readonly CampaignCoverageSessionValue[],
): string {
  const normalizedSessions = sessions.map((session) => ({
    ...session,
    venueName: normalizeString(session.venueName),
  }));
  const ordered = normalizedSessions.sort(compareCoverageSessions).map((session) => ({
    district: session.district,
    province: session.province,
    venueName: session.venueName,
    examDate: session.examDate,
    reportingTimeHour: session.reportingTimeHour,
    capacityLimit: session.capacityLimit,
    isActive: session.isActive,
  }));
  return hashCampaignCanonicalJson({ campaignId, sessions: ordered });
}

function uuidBytes(uuid: string): Buffer {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new TypeError('UUID namespace must be a canonical UUID');
  }
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

/** RFC 4122 UUIDv5: stable identity for an immutable campaign fact. */
export function campaignFactUuid(namespace: string, name: string): string {
  const digest = createHash('sha1')
    .update(uuidBytes(namespace))
    .update(Buffer.from(normalizeString(name), 'utf8'))
    .digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
