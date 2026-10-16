// ══════════════════════════════════════════════════════════════════
// rehearsal — the production fence
//
// A rehearsal provisions an agency administrator through the first-admin
// function and publishes campaigns. Pointed at a real deployment that would
// be indistinguishable from an intrusion, so the fence is checked before any
// connection is opened and fails closed on anything it does not recognise.
// ══════════════════════════════════════════════════════════════════

export class RehearsalRefused extends Error {
  override readonly name = 'RehearsalRefused';
}

export interface FenceInput {
  readonly nodeEnv: string | undefined;
  readonly databaseUrl: string;
  readonly edgeBaseUrl: string;
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostOf(url: string, what: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RehearsalRefused(`${what} is not a valid URL.`);
  }
  return parsed.hostname.toLowerCase();
}

/** PURE. Throws RehearsalRefused unless every target is a local development one. */
export function assertRehearsalAllowed(input: FenceInput): void {
  if ((input.nodeEnv ?? '').trim().toLowerCase() === 'production') {
    throw new RehearsalRefused('Refusing to rehearse with NODE_ENV=production.');
  }
  const dbHost = hostOf(input.databaseUrl, 'The rehearsal database URL');
  if (!LOCAL_HOSTS.has(dbHost)) {
    throw new RehearsalRefused(`Refusing to rehearse against a non-local database host (${dbHost}).`);
  }
  const edgeHost = hostOf(input.edgeBaseUrl, 'The edge URL');
  if (!LOCAL_HOSTS.has(edgeHost)) {
    throw new RehearsalRefused(`Refusing to rehearse against a non-local edge (${edgeHost}).`);
  }
}
