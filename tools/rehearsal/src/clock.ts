// Rehearsal dates are relative to "today" in Rwanda, because that is the day
// the gate checks (ADR-034 compares the exam date with the Africa/Kigali date).

const KIGALI = 'Africa/Kigali';
const DAY_MS = 86_400_000;

/** PURE. The Africa/Kigali calendar date `offsetDays` from `now`, as YYYY-MM-DD. */
export function kigaliDate(now: Date, offsetDays = 0): string {
  const shifted = new Date(now.getTime() + offsetDays * DAY_MS);
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: KIGALI, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
}

/** PURE. YYYYMMDD of today's Kigali date: the per-day rehearsal stamp. */
export function kigaliStamp(now: Date): string {
  return kigaliDate(now).replaceAll('-', '');
}

/**
 * PURE. The start (00:00:00) or end (23:59:59) of the Kigali day `offsetDays`
 * from `now`, as ISO-8601 with Rwanda's fixed +02:00 offset (no DST). Anchored
 * to the calendar day, never to the current millisecond: a control-plane
 * command must be byte-identical when a rehearsal is replayed the same day,
 * or its Idempotency-Key is (correctly) refused as reused.
 */
export function kigaliInstant(now: Date, offsetDays: number, edge: 'start' | 'end'): string {
  return `${kigaliDate(now, offsetDays)}T${edge === 'start' ? '00:00:00' : '23:59:59'}+02:00`;
}

/** PURE. "16 Oct" for the human campaign label. */
export function shortDay(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(date);
}
