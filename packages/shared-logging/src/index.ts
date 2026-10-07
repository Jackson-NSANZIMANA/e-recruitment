// ══════════════════════════════════════════════════════════════════
// @usrp/shared-logging — public surface
//
// The single redacting log sink shared by every service and shared package.
// See src/sink.ts for why it writes to process.stdout rather than console.*,
// and src/redact.ts for the redaction control it enforces on every line.
// ══════════════════════════════════════════════════════════════════

export { redact, summariseError } from './redact.js';
export { logError, logInfo, logWarn, structuredLine, type LogFields } from './sink.js';
