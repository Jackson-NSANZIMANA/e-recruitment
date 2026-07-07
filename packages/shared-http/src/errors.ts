// ══════════════════════════════════════════════════════════════════
// @usrp/shared-http — HttpError
//
// The one error type the transport understands. A handler throws it to
// produce a deterministic status + machine-readable code. 5xx details are
// never sent to the client (they may carry internal specifics); 4xx
// details are safe, caller-facing hints. Business outcomes are NOT errors
// — services return them as values; only genuinely exceptional conditions
// throw.
// ══════════════════════════════════════════════════════════════════

export class HttpError extends Error {
  readonly status: number;
  /** Stable, machine-readable code, e.g. `MALFORMED_JSON`. */
  readonly code: string;
  /** Whether `message` is safe to return to the client (default: status < 500). */
  readonly expose: boolean;

  constructor(
    status: number,
    code: string,
    detail?: string,
    options?: { readonly cause?: unknown; readonly expose?: boolean },
  ) {
    super(
      detail ?? code,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.expose = options?.expose ?? status < 500;
  }
}
