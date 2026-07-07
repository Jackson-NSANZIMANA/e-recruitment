// ══════════════════════════════════════════════════════════════════
// @usrp/shared-config — Zero-dependency typed environment loader
//
// Design goals:
//   1. Fail fast, fail LOUD — a service must not boot with a bad config.
//   2. Aggregate ALL validation errors into a single throw, so operators
//      fix every problem in one pass instead of one-at-a-time.
//   3. No runtime dependencies — smaller supply-chain surface, which
//      matters for a national-security system.
//   4. Secrets are never echoed back in error messages.
// ══════════════════════════════════════════════════════════════════

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Thrown when one or more environment variables fail validation. */
export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid environment configuration (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n` +
        issues.map((i) => `  - ${i}`).join('\n'),
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = <T>(error: string): ParseResult<T> => ({ ok: false, error });

/**
 * A validator for a single environment variable. `secret: true` marks a
 * value that must never appear in logs or error output.
 */
export interface EnvSpec<T> {
  readonly parse: (key: string, raw: string | undefined) => ParseResult<T>;
  readonly secret: boolean;
}

const isEmpty = (raw: string | undefined): raw is undefined | '' =>
  raw === undefined || raw === '';

/**
 * Recursively freeze an object graph. The `readonly` types are compile-time
 * only; config is read across every service, so we also enforce immutability
 * at runtime — an accidental write throws instead of silently corrupting
 * shared configuration.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// ── Primitive specs ───────────────────────────────────────────────

export interface StringOpts {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  readonly secret?: boolean;
}

export function string(opts: StringOpts = {}): EnvSpec<string> {
  const secret = opts.secret ?? false;
  return {
    secret,
    parse: (key, raw) => {
      if (isEmpty(raw)) return fail(`${key} is required`);
      if (opts.minLength !== undefined && raw.length < opts.minLength) {
        return fail(`${key} must be at least ${opts.minLength} characters`);
      }
      if (opts.maxLength !== undefined && raw.length > opts.maxLength) {
        return fail(`${key} must be at most ${opts.maxLength} characters`);
      }
      if (opts.pattern !== undefined && !opts.pattern.test(raw)) {
        return fail(`${key} does not match required format`);
      }
      return ok(raw);
    },
  };
}

export function integer(opts: { readonly min?: number; readonly max?: number } = {}): EnvSpec<number> {
  return {
    secret: false,
    parse: (key, raw) => {
      if (isEmpty(raw)) return fail(`${key} is required`);
      const n = Number(raw);
      if (!Number.isInteger(n)) return fail(`${key} must be an integer, got "${raw}"`);
      if (opts.min !== undefined && n < opts.min) return fail(`${key} must be >= ${opts.min}`);
      if (opts.max !== undefined && n > opts.max) return fail(`${key} must be <= ${opts.max}`);
      return ok(n);
    },
  };
}

/** A TCP port number (1–65535). */
export const port = (): EnvSpec<number> => integer({ min: 1, max: 65535 });

export function boolean(): EnvSpec<boolean> {
  return {
    secret: false,
    parse: (key, raw) => {
      if (isEmpty(raw)) return fail(`${key} is required`);
      const v = raw.trim().toLowerCase();
      if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return ok(true);
      if (v === '0' || v === 'false' || v === 'no' || v === 'off') return ok(false);
      return fail(`${key} must be a boolean (true/false), got "${raw}"`);
    },
  };
}

export function url(opts: { readonly protocols?: readonly string[] } = {}): EnvSpec<string> {
  return {
    secret: false,
    parse: (key, raw) => {
      if (isEmpty(raw)) return fail(`${key} is required`);
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return fail(`${key} must be a valid URL`);
      }
      if (opts.protocols !== undefined) {
        const scheme = parsed.protocol.replace(/:$/, '');
        if (!opts.protocols.includes(scheme)) {
          return fail(`${key} must use one of protocols: ${opts.protocols.join(', ')}`);
        }
      }
      return ok(raw);
    },
  };
}

export function oneOf<const T extends readonly string[]>(values: T): EnvSpec<T[number]> {
  return {
    secret: false,
    parse: (key, raw) => {
      if (isEmpty(raw)) return fail(`${key} is required`);
      if (!values.includes(raw)) {
        return fail(`${key} must be one of: ${values.join(' | ')}, got "${raw}"`);
      }
      return ok(raw as T[number]);
    },
  };
}

/** Comma-separated (or custom-separator) list, e.g. KAFKA_BROKERS. */
export function list(
  opts: { readonly separator?: string; readonly minItems?: number } = {},
): EnvSpec<readonly string[]> {
  const separator = opts.separator ?? ',';
  return {
    secret: false,
    parse: (key, raw) => {
      if (isEmpty(raw)) return fail(`${key} is required`);
      const items = raw
        .split(separator)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (opts.minItems !== undefined && items.length < opts.minItems) {
        return fail(`${key} must contain at least ${opts.minItems} item(s)`);
      }
      return ok(items);
    },
  };
}

// ── Combinators ───────────────────────────────────────────────────

/** Makes a spec optional — an absent/empty value resolves to `undefined`. */
export function optional<T>(spec: EnvSpec<T>): EnvSpec<T | undefined> {
  return {
    secret: spec.secret,
    parse: (key, raw) => (isEmpty(raw) ? ok(undefined) : spec.parse(key, raw)),
  };
}

/** Supplies a default when the variable is absent/empty. */
export function withDefault<T>(spec: EnvSpec<T>, defaultValue: T): EnvSpec<T> {
  return {
    secret: spec.secret,
    parse: (key, raw) => (isEmpty(raw) ? ok(defaultValue) : spec.parse(key, raw)),
  };
}

// ── Loader ────────────────────────────────────────────────────────

export type EnvSchema = Readonly<Record<string, EnvSpec<unknown>>>;

export type InferEnv<S extends EnvSchema> = {
  readonly [K in keyof S]: S[K] extends EnvSpec<infer T> ? T : never;
};

/**
 * Validate an environment against a schema. Collects every failure and
 * throws a single {@link EnvValidationError}; returns a fully-typed,
 * frozen config object on success.
 */
export function loadEnv<S extends EnvSchema>(
  schema: S,
  source: EnvSource = process.env,
): InferEnv<S> {
  const result: Record<string, unknown> = {};
  const issues: string[] = [];

  for (const key of Object.keys(schema)) {
    const spec = schema[key];
    if (spec === undefined) continue; // satisfies noUncheckedIndexedAccess
    const parsed = spec.parse(key, source[key]);
    if (parsed.ok) {
      result[key] = parsed.value;
    } else {
      issues.push(parsed.error);
    }
  }

  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }

  return deepFreeze(result) as InferEnv<S>;
}
