// ══════════════════════════════════════════════════════════════════
// rehearsal — an officer session at the edge, held the way a browser holds it
//
// The conductor never calls a service port: every campaign command goes
// through /edge/v1/** with the session cookie, the double-submit CSRF token,
// a pinned Origin and an Idempotency-Key — the same path the officer console
// uses, so a rehearsal exercises the guarantees rather than bypassing them.
// ══════════════════════════════════════════════════════════════════

export interface EdgeResponse {
  readonly status: number;
  readonly replayed: boolean;
  readonly body: unknown;
}

export class EdgeUnavailable extends Error {
  override readonly name = 'EdgeUnavailable';
}

const CSRF_COOKIE = /^(?:__Host-usrp_csrf|usrp_csrf_dev)$/;

export class EdgeSession {
  private readonly cookies = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    private readonly origin: string,
  ) {}

  private absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const eq = pair?.indexOf('=') ?? -1;
      if (pair === undefined || eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /max-age=0/i.test(header)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private csrfToken(): string | null {
    for (const [name, value] of this.cookies) if (CSRF_COOKIE.test(name)) return value;
    return null;
  }

  private async send(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<EdgeResponse> {
    const headers: Record<string, string> = { accept: 'application/json', origin: this.origin };
    if (this.cookies.size > 0) headers['cookie'] = [...this.cookies].map(([n, v]) => `${n}=${v}`).join('; ');
    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      const csrf = this.csrfToken();
      if (csrf !== null) headers['x-csrf-token'] = csrf;
    }
    if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new EdgeUnavailable(`The edge at ${this.baseUrl} is not reachable (${error instanceof Error ? error.message : String(error)}). Is \`pnpm dev\` running?`);
    }
    this.absorb(response);
    const text = await response.text();
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 200) };
      }
    }
    return { status: response.status, replayed: response.headers.get('idempotency-replayed') === 'true', body: parsed };
  }

  get(path: string): Promise<EdgeResponse> {
    return this.send('GET', path);
  }

  post(path: string, body: unknown, idempotencyKey?: string): Promise<EdgeResponse> {
    return this.send('POST', path, body, idempotencyKey);
  }

  /** Officer sign-in: obtain the CSRF cookie, then the session cookie. True on success. */
  async signIn(loginHandle: string, password: string): Promise<boolean> {
    await this.get('/edge/v1/session');
    const login = await this.post('/edge/v1/auth/officer/login', { loginHandle, password });
    if (login.status < 200 || login.status >= 300) return false;
    const session = await this.get('/edge/v1/session');
    return session.status === 200;
  }
}
