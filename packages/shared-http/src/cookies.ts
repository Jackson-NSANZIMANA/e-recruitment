// ══════════════════════════════════════════════════════════════════
// @usrp/shared-http — Cookie serialization + parsing (RFC 6265 / 6265bis)
//
// The transport gained cookies for exactly ONE reason: the edge (BFF) tier
// keeps the upstream credential SERVER-SIDE and hands the browser an opaque
// handle. That requires emitting more than one Set-Cookie per response — the
// session handle plus the readable CSRF echo — which a
// Readonly<Record<string, string>> header map physically cannot express.
// Hence a first-class `cookies` field on HttpResult rather than a header hack.
//
// Two deliberate hard lines:
//
//   1. `__Host-` INVARIANTS ARE ENFORCED, NOT DOCUMENTED. A __Host- prefixed
//      cookie MUST be Secure, MUST be Path=/, and MUST NOT carry a Domain.
//      Browsers SILENTLY DROP a cookie that breaks these rules, and a silent
//      auth failure is the worst failure mode available — so we throw at
//      serialization time instead. A malformed cookie is a PROGRAMMER bug, so
//      it raises a plain Error (rendered as a 500), never an HttpError shaped
//      to look like the client's fault.
//
//   2. NAME/VALUE ARE VALIDATED AND REFUSED, NEVER ESCAPED. An unescaped ';'
//      or CRLF in a cookie value is a response-splitting primitive. Silently
//      rewriting a credential is worse than refusing to emit it, so we refuse.
//      Session handles and CSRF tokens are base64url/hex, which are always
//      valid cookie-octets — a violation means something is wrong upstream.
//
// Zero dependencies — no cookie library in the supply chain for ~120 lines.
// ══════════════════════════════════════════════════════════════════

/** SameSite policy. Every USRP edge cookie is 'Strict'. */
export type CookieSameSite = 'Strict' | 'Lax' | 'None';

/**
 * A cookie to emit. Attributes are explicit with no implicit defaults —
 * a "helpful" default here would silently weaken a session credential.
 */
export interface SetCookie {
  readonly name: string;
  /** Value. Pass '' with `maxAgeSeconds: 0` to clear the cookie. */
  readonly value: string;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: CookieSameSite;
  readonly path?: string;
  readonly domain?: string;
  /** Max-Age in seconds. 0 expires the cookie immediately. */
  readonly maxAgeSeconds?: number;
  readonly expires?: Date;
}

/** The `__Host-` prefix: host-locked, path-locked, Secure-only cookies. */
export const HOST_COOKIE_PREFIX = '__Host-';

/** RFC 6265 `cookie-name` — an RFC 7230 token. */
const COOKIE_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * RFC 6265 `cookie-octet`: US-ASCII printable EXCEPT whitespace, DQUOTE,
 * comma, semicolon and backslash. Written as explicit ranges because the
 * excluded characters are precisely the header-injection alphabet.
 */
const COOKIE_OCTET_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

/** Attribute values (Path, Domain) may not smuggle attribute separators. */
const ATTR_VALUE_RE = /^[\x20-\x3A\x3C-\x7E]*$/;

function assertAttribute(cookieName: string, attribute: string, value: string): void {
  if (!ATTR_VALUE_RE.test(value)) {
    throw new Error(
      `Cookie "${cookieName}": ${attribute} contains a character that could smuggle a Set-Cookie attribute.`,
    );
  }
}

/**
 * Render one `Set-Cookie` header value.
 *
 * THROWS (plain Error — a programmer bug, not a client error) when the cookie
 * would be silently dropped or would corrupt the response header.
 */
export function serializeSetCookie(cookie: SetCookie): string {
  if (!COOKIE_NAME_RE.test(cookie.name)) {
    throw new Error(`Invalid cookie name ${JSON.stringify(cookie.name)}: must be an RFC 6265 token.`);
  }
  if (!COOKIE_OCTET_RE.test(cookie.value)) {
    throw new Error(
      `Invalid value for cookie "${cookie.name}": must be RFC 6265 cookie-octets ` +
        '(base64url and hex always are). Refused rather than escaped — escaping a credential silently is worse.',
    );
  }

  // ── __Host- invariants: fail loud instead of being silently dropped ──
  if (cookie.name.startsWith(HOST_COOKIE_PREFIX)) {
    if (cookie.secure !== true) {
      throw new Error(`Cookie "${cookie.name}": the __Host- prefix requires Secure; browsers drop it otherwise.`);
    }
    if (cookie.path !== '/') {
      throw new Error(`Cookie "${cookie.name}": the __Host- prefix requires Path=/; browsers drop it otherwise.`);
    }
    if (cookie.domain !== undefined) {
      throw new Error(
        `Cookie "${cookie.name}": the __Host- prefix FORBIDS a Domain attribute — that host-locking is the ` +
          'entire reason the prefix is used (a sibling *.gov.rw host must not be able to write it).',
      );
    }
  }

  // SameSite=None without Secure is rejected by every current browser.
  if (cookie.sameSite === 'None' && cookie.secure !== true) {
    throw new Error(`Cookie "${cookie.name}": SameSite=None requires Secure.`);
  }

  const parts: string[] = [`${cookie.name}=${cookie.value}`];

  if (cookie.path !== undefined) {
    assertAttribute(cookie.name, 'Path', cookie.path);
    parts.push(`Path=${cookie.path}`);
  }
  if (cookie.domain !== undefined) {
    assertAttribute(cookie.name, 'Domain', cookie.domain);
    parts.push(`Domain=${cookie.domain}`);
  }
  if (cookie.maxAgeSeconds !== undefined) {
    if (!Number.isInteger(cookie.maxAgeSeconds) || cookie.maxAgeSeconds < 0) {
      throw new Error(`Cookie "${cookie.name}": Max-Age must be a non-negative integer.`);
    }
    parts.push(`Max-Age=${cookie.maxAgeSeconds}`);
  }
  if (cookie.expires !== undefined) {
    parts.push(`Expires=${cookie.expires.toUTCString()}`);
  }
  if (cookie.sameSite !== undefined) {
    parts.push(`SameSite=${cookie.sameSite}`);
  }
  if (cookie.secure === true) parts.push('Secure');
  if (cookie.httpOnly === true) parts.push('HttpOnly');

  return parts.join('; ');
}

/**
 * Parse an inbound `Cookie` header into a jar.
 *
 * FIRST OCCURRENCE WINS. A duplicate name later in the header is the classic
 * cookie-shadowing trick (a compromised sibling subdomain writing a
 * Domain-scoped duplicate). __Host- makes our own cookies unwritable that way,
 * but a DETERMINISTIC jar is a precondition for the CSRF double-submit
 * comparison to mean anything at all, so the rule is applied to every name.
 */
export function parseCookieHeader(header: string | undefined): ReadonlyMap<string, string> {
  const jar = new Map<string, string>();
  if (header === undefined || header.length === 0) return jar;

  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue; // no '=' at all, or an empty name
    const name = pair.slice(0, eq).trim();
    if (name.length === 0 || jar.has(name)) continue;
    let value = pair.slice(eq + 1).trim();
    // RFC 6265 permits a DQUOTE-wrapped value; unwrap only matched pairs.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    jar.set(name, value);
  }
  return jar;
}
