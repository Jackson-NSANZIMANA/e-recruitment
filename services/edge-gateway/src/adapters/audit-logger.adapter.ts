// ══════════════════════════════════════════════════════════════════
// edge-gateway — Audit logger adapter
//
// Implements the AuditLogger port using structured JSON logging to stdout.
// In production, stdout is collected by the platform's log aggregator.
//
// Part of hexagonal architecture refactoring - adapter layer.
// ══════════════════════════════════════════════════════════════════

import type { AuditLogger, AuditEvent, SessionStatsEvent } from '../ports/audit-logger.js';

/**
 * Structured JSON audit logger. Emits events to stdout as newline-delimited
 * JSON, which the platform's log collector ingests.
 */
export class ConsoleAuditLogger implements AuditLogger {
  log(event: AuditEvent): void {
    console.log(JSON.stringify({
      ...event,
      timestamp: event.timestamp ?? new Date(),
    }));
  }

  logStats(stats: SessionStatsEvent): void {
    console.log(JSON.stringify({
      msg: 'edge_session_stats',
      ...stats,
      timestamp: new Date(),
    }));
  }
}

/**
 * Factory function for creating audit logger.
 */
export function createAuditLogger(): AuditLogger {
  return new ConsoleAuditLogger();
}

/**
 * Audit edge event (existing API for backward compatibility).
 * Delegates to a singleton instance.
 */
const defaultLogger = new ConsoleAuditLogger();

export function auditEdge(event: AuditEvent): void {
  defaultLogger.log(event);
}

export function auditEdgeStats(stats: SessionStatsEvent): void {
  defaultLogger.logStats(stats);
}

/**
 * Redact sensitive fields from objects before logging (existing export).
 */
export function redact<T extends Record<string, unknown>>(
  obj: T,
  fields: readonly string[]
): T {
  const result = { ...obj };
  for (const field of fields) {
    if (field in result) {
      (result as Record<string, unknown>)[field] = '[REDACTED]';
    }
  }
  return result;
}
