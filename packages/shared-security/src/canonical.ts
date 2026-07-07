// ══════════════════════════════════════════════════════════════════
// @usrp/shared-security — Canonical JSON
//
// Deterministic serialization is the foundation of every signature and
// content hash in the system: two semantically-identical payloads must
// produce byte-identical output regardless of key insertion order, or
// signature verification becomes non-deterministic.
// ══════════════════════════════════════════════════════════════════

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function sortValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((v: JsonValue) => sortValue(v));
  }
  if (value !== null && typeof value === 'object') {
    const source = value as { readonly [key: string]: JsonValue };
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort()) {
      const v = source[key];
      if (v === undefined) continue; // omit undefined — keeps output stable
      out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

/** Serialize a JSON value with recursively sorted object keys. */
export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortValue(value));
}
