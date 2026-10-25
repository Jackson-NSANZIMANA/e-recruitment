// The IremboGov envelope: {status, message, responseCode, timestamp, traceId, data}.
import { randomBytes } from 'node:crypto';

/** "2026-10-25T17:17:00.123456789+02:00": Kigali offset, nanosecond field as observed. */
export function iremboTimestamp(now: Date): string {
  const kigali = new Date(now.getTime() + 2 * 3600 * 1000);
  const iso = kigali.toISOString(); // ...THH:MM:SS.mmmZ
  const nanos = `${iso.slice(20, 23)}${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
  return `${iso.slice(0, 19)}.${nanos}+02:00`;
}

export function traceId(): string {
  return randomBytes(16).toString('hex');
}

export function iremboEnvelope(now: Date, status: boolean, code: string, data: unknown): Record<string, unknown> {
  return { status, message: code, responseCode: code, timestamp: iremboTimestamp(now), traceId: traceId(), data };
}
