// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — the captured CONTRACTS and a dependency-free validator
//
// contracts/*.schema.json are the observed wire shapes with every value
// stripped. Every simulator response is tested against them, and the live
// NESA passthrough re-validates production bytes against the same file, so
// a drift between the simulators and the real API turns red (ADR-047 §4).
//
// The validator implements the JSON Schema subset those files use: type
// (single or list), const, enum, pattern, minLength, minimum, maximum,
// integer, properties, required, additionalProperties:false, items.
// Its messages name PATHS only, never values.
// ══════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface JsonSchema {
  readonly type?: string | readonly string[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly pattern?: string;
  readonly minLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
}

export const CONTRACTS = {
  nidaIdentity: 'irembo-user-profile-with-identity-info',
  sdmsResults: 'sdms-results-by-index',
  iremboCertificate: 'irembo-certificate-verification',
} as const;
export type ContractName = (typeof CONTRACTS)[keyof typeof CONTRACTS];

const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts');
const cache = new Map<string, JsonSchema>();

export function loadContract(name: ContractName): JsonSchema {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const schema = JSON.parse(readFileSync(join(CONTRACTS_DIR, `${name}.schema.json`), 'utf8')) as JsonSchema;
  cache.set(name, schema);
  return schema;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  return actual === expected || (expected === 'number' && actual === 'integer');
}

/** Validate; returns the violated paths (empty = valid). Never echoes a value. */
export function validate(schema: JsonSchema, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const types = typeof schema.type === 'string' ? [schema.type] : schema.type;
    if (!types.some((t) => typeMatches(value, t))) return [`${path}: expected ${types.join('|')}, got ${typeOf(value)}`];
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: not the required constant`);
  if (schema.enum !== undefined && !schema.enum.includes(value)) errors.push(`${path}: not an allowed value`);
  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: does not match the captured format`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => { errors.push(...validate(schema.items as JsonSchema, item, `${path}[${String(i)}]`)); });
  }
  if (typeOf(value) === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) errors.push(`${path}.${key}: missing`);
    for (const [key, child] of Object.entries(record)) {
      const sub = schema.properties?.[key];
      if (sub === undefined) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: not in the captured shape`);
        continue;
      }
      errors.push(...validate(sub, child, `${path}.${key}`));
    }
  }
  return errors;
}

export function validateContract(name: ContractName, value: unknown): string[] {
  return validate(loadContract(name), value);
}
