// ══════════════════════════════════════════════════════════════════
// @usrp/shared-http — multipart/form-data parsing (RFC 7578 / RFC 2046)
//
// The transport gained this for exactly ONE reason: the applicant wizard's
// certificate upload. ctx.json() is the only body parser the substrate had,
// and a file upload is not JSON. rawBody() (P0) made the bytes reachable;
// this makes them interpretable.
//
// A PURE FUNCTION OVER A BUFFER, not a method on RequestContext. Every framing
// case below — truncated body, duplicate field, missing closing boundary — is
// then provable with a Buffer literal, no socket and no server. A parser that
// can only be exercised through a live request is a parser whose edge cases
// never get tested.
//
// ── THE TRAP THIS MODULE EXISTS TO DOCUMENT ──────────────────────
//
// `ctx.contentType` IS LOWER-CASED. That is correct for cheap comparisons and
// CATASTROPHIC here: RFC 2046 boundary bchars are CASE-SENSITIVE, and every
// real browser boundary carries mixed case (----WebKitFormBoundaryAbC123,
// ----formdata-undici-0aBc). Lower-cased, the delimiter matches NOTHING in the
// body and every upload in production fails as "malformed" for a reason no log
// would ever explain. So this module exports rawContentType(headers), reads the
// header verbatim, and takes the content-type as an ARGUMENT rather than
// quietly trusting ctx. ctx.contentType is deliberately left unchanged — the
// JSON callers legitimately depend on the lower-casing.
//
// Zero dependencies, like the rest of the transport: no busboy, no multer, no
// supply-chain surface added to a national deployment for byte arithmetic.
// ══════════════════════════════════════════════════════════════════

import type { IncomingHttpHeaders } from 'node:http';
import { HttpError } from './errors.js';

/** One uploaded file part. `bytes` is the exact, unmodified part content. */
export interface MultipartFile {
  /** The form field name (Content-Disposition `name`). */
  readonly fieldName: string;
  /**
   * The client-supplied filename. RETURNED, NEVER TRUSTED: it is fully
   * attacker-controlled. A stored object's key must be DERIVED from validated
   * closed-set inputs — a client-supplied key is a path-traversal and a
   * write-into-someone-else's-record primitive in a single field.
   */
  readonly filename: string;
  /** Lower-cased media type from the part's own Content-Type (no parameters). */
  readonly contentType: string;
  readonly bytes: Buffer;
}

/** A parsed multipart body: text fields plus file parts. */
export interface MultipartForm {
  /**
   * Non-file fields, decoded UTF-8. FIRST OCCURRENCE WINS — the same rule as
   * the cookie jar, for the same reason: a value that depends on which
   * duplicate a parser happens to keep is a smuggling primitive the moment two
   * layers disagree about it.
   */
  readonly fields: ReadonlyMap<string, string>;
  readonly files: readonly MultipartFile[];
}

/**
 * Structural limits. Route.maxBodyBytes bounds the TOTAL body and does nothing
 * about 50,000 tiny parts inside a perfectly legal one — that is a parser-CPU
 * DoS, so these are enforced, not advisory. Defaults are deliberately mean.
 */
export interface MultipartLimits {
  /** Maximum number of parts of any kind (default 16). */
  readonly maxParts?: number;
  /** Maximum number of FILE parts (default 1). */
  readonly maxFiles?: number;
  /** Maximum bytes in a single non-file field (default 8 KiB). */
  readonly maxFieldBytes?: number;
}

const DEFAULT_MAX_PARTS = 16;
const DEFAULT_MAX_FILES = 1;
const DEFAULT_MAX_FIELD_BYTES = 8 * 1024;

const CRLF = Buffer.from('\r\n', 'latin1');
const CRLF_CRLF = Buffer.from('\r\n\r\n', 'latin1');
const DASH_DASH = Buffer.from('--', 'latin1');

/**
 * RFC 2046 bchars. SPACE is legal in a quoted boundary but is excluded here on
 * purpose: no real client emits one, and accepting it would mean parsing quoted
 * parameters with embedded whitespace for zero benefit.
 */
const BOUNDARY_RE = /^[0-9A-Za-z'()+_,\-./:=?]{1,70}$/;

/** Only linear whitespace (transport padding) may follow a boundary. */
const BOUNDARY_PADDING_RE = /^[ \t]*$/;

function malformed(detail: string): HttpError {
  return new HttpError(400, 'MALFORMED_MULTIPART', detail);
}

/**
 * The RAW, case-preserving `content-type` request header.
 *
 * MANDATORY for multipart, not stylistic — see the module header: the boundary
 * is case-sensitive and `ctx.contentType` is lower-cased.
 */
export function rawContentType(headers: IncomingHttpHeaders): string {
  const value = headers['content-type'];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** Extract and validate the boundary. 415 when the body is not multipart at all. */
function boundaryFrom(contentType: string): string {
  if (!contentType.trimStart().toLowerCase().startsWith('multipart/form-data')) {
    throw new HttpError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Content-Type must be multipart/form-data.',
    );
  }
  const match = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const raw = match?.[1] ?? match?.[2];
  if (raw === undefined || raw.length === 0) {
    throw malformed('Content-Type is missing the required boundary parameter.');
  }
  if (!BOUNDARY_RE.test(raw)) {
    throw malformed('The boundary parameter is not a valid RFC 2046 boundary.');
  }
  return raw;
}

/**
 * One part header by lower-cased name. Obsolete line folding (obs-fold) is
 * deliberately unsupported: half-parsing a security-relevant header is worse
 * than refusing it, and no client has emitted a folded part header this decade.
 */
function partHeader(headerBlock: string, name: string): string | undefined {
  for (const line of headerBlock.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() === name) return line.slice(colon + 1).trim();
  }
  return undefined;
}

/**
 * A Content-Disposition parameter. Matches only at a `;`, so `filename=` can
 * never satisfy a request for `name=`. `filename*=` (RFC 5987) does not match
 * and is therefore ignored rather than mis-decoded.
 */
function dispositionParam(disposition: string, param: 'name' | 'filename'): string | undefined {
  const re = new RegExp(`;\\s*${param}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]*))`, 'i');
  const match = re.exec(disposition);
  if (match === null) return undefined;
  const quoted = match[1];
  // Quoted-pair unescaping: a filename may legally contain \" or \\.
  if (quoted !== undefined) return quoted.replace(/\\(.)/g, '$1');
  const bare = match[2];
  return bare !== undefined && bare.length > 0 ? bare : undefined;
}

/** Media type without parameters, lower-cased (`image/png; x=1` → `image/png`). */
function mediaType(headerValue: string | undefined): string {
  if (headerValue === undefined) return '';
  return (headerValue.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Parse a `multipart/form-data` body.
 *
 * Throws HttpError: 415 when the content-type is not multipart, 400 on any
 * framing violation (including a MISSING CLOSING BOUNDARY — see below), 413
 * when a text field exceeds its cap.
 *
 * WHY A MISSING CLOSING BOUNDARY IS A HARD 400: a connection dropped mid-body
 * would otherwise parse as a complete file with silently missing tail bytes.
 * For a document that gets virus-scanned, a silently truncated file is the
 * worst outcome available — it scans clean because the hostile tail never
 * arrived. Truncation must be an error, never a shorter file.
 */
export function parseMultipartFormData(
  body: Buffer,
  contentType: string,
  limits: MultipartLimits = {},
): MultipartForm {
  const boundary = boundaryFrom(contentType);
  const maxParts = limits.maxParts ?? DEFAULT_MAX_PARTS;
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFieldBytes = limits.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;

  const delimiter = Buffer.concat([CRLF, DASH_DASH, Buffer.from(boundary, 'latin1')]);
  // A leading CRLF makes the OPENING delimiter byte-identical to every inner
  // one, so a single scan handles both. Special-casing the first boundary is
  // where hand-rolled multipart parsers grow their off-by-one bugs.
  const scan = Buffer.concat([CRLF, body]);

  const fields = new Map<string, string>();
  const files: MultipartFile[] = [];

  let cursor = scan.indexOf(delimiter);
  if (cursor === -1) throw malformed('No opening boundary delimiter found in the request body.');

  let parts = 0;
  let closed = false;

  while (cursor !== -1) {
    const afterDelimiter = cursor + delimiter.length;

    // The closing delimiter is `--boundary--`.
    if (scan.subarray(afterDelimiter, afterDelimiter + DASH_DASH.length).equals(DASH_DASH)) {
      closed = true;
      break;
    }

    const lineEnd = scan.indexOf(CRLF, afterDelimiter);
    if (lineEnd === -1) throw malformed('A boundary delimiter line is not terminated.');
    if (!BOUNDARY_PADDING_RE.test(scan.subarray(afterDelimiter, lineEnd).toString('latin1'))) {
      throw malformed('Unexpected data between a boundary delimiter and its line break.');
    }

    const partStart = lineEnd + CRLF.length;
    const next = scan.indexOf(delimiter, partStart);
    if (next === -1) {
      throw malformed('A part is unterminated — the closing boundary is missing (truncated upload).');
    }

    parts += 1;
    if (parts > maxParts) {
      throw malformed(`Too many parts (limit ${maxParts}).`);
    }

    const headerEnd = scan.indexOf(CRLF_CRLF, partStart);
    if (headerEnd === -1 || headerEnd > next) {
      throw malformed('A part has no terminated header block.');
    }
    const headerBlock = scan.subarray(partStart, headerEnd).toString('latin1');
    const content = scan.subarray(headerEnd + CRLF_CRLF.length, next);

    const disposition = partHeader(headerBlock, 'content-disposition');
    if (disposition === undefined) throw malformed('A part is missing Content-Disposition.');
    const fieldName = dispositionParam(disposition, 'name');
    if (fieldName === undefined) throw malformed('A part is missing its Content-Disposition name.');
    const filename = dispositionParam(disposition, 'filename');

    if (filename === undefined) {
      // A text field.
      if (content.length > maxFieldBytes) {
        throw new HttpError(
          413,
          'FIELD_TOO_LARGE',
          `Field "${fieldName}" exceeds the ${maxFieldBytes}-byte limit.`,
        );
      }
      // First occurrence wins (see MultipartForm.fields).
      if (!fields.has(fieldName)) fields.set(fieldName, content.toString('utf8'));
    } else {
      if (files.length + 1 > maxFiles) {
        throw malformed(`Too many file parts (limit ${maxFiles}).`);
      }
      files.push({
        fieldName,
        filename,
        contentType: mediaType(partHeader(headerBlock, 'content-type')),
        bytes: content,
      });
    }

    cursor = next;
  }

  if (!closed) {
    throw malformed('The closing boundary delimiter is missing (truncated upload).');
  }
  return { fields, files };
}
