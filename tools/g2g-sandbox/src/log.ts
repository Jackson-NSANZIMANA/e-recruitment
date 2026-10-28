// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — a REDACTING logger (ADR-047 §3.5)
//
// Redaction is by field ALLOWLIST: a log record keeps only the keys below,
// whose values are operational (module, status, persona id, behaviour,
// duration). Any other key, a name, a NID, an index number, a photo, is
// dropped before the record exists, so a private-persona value cannot reach
// a log line even by mistake. Persona ids are catalogue ids or "PRIVATE".
// ══════════════════════════════════════════════════════════════════

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'module', 'status', 'persona', 'behaviour', 'durationMs', 'reason', 'port', 'environment',
  'citizens', 'personas', 'overlay', 'live', 'seed', 'modules', 'method',
]);

export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface SandboxLog {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

export function redact(fields: LogFields): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    // Strings are bounded and must look operational (no long free text).
    if (typeof value === 'string' && (value.length > 64 || /\d{8,}/.test(value))) continue;
    out[key] = value;
  }
  return out;
}

export function consoleLog(write: (line: string) => void = (line) => { process.stdout.write(`${line}\n`); }): SandboxLog {
  const emit = (level: string, event: string, fields: LogFields = {}): void => {
    write(JSON.stringify({ level, service: 'g2g-sandbox', event, ...redact(fields), at: new Date().toISOString() }));
  };
  return {
    info: (event, fields): void => { emit('info', event, fields); },
    warn: (event, fields): void => { emit('warn', event, fields); },
  };
}

export const silentLog: SandboxLog = { info: () => undefined, warn: () => undefined };
