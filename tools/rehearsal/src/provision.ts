// ══════════════════════════════════════════════════════════════════
// rehearsal — the agency administrator a rehearsal publishes as
//
// Dev officers are deliberately NOT agency_admin; campaign authoring belongs
// to the separately provisioned first administrator (BUILD-001). The
// rehearsal therefore provisions its administrator through the SAME
// function an operator uses — provision_first_campaign_agency_admin, with its
// audit event — under the provisioner session identity, emulated from a
// privileged LOCAL connection exactly as the BUILD-001 HTTP proof does. It is
// not password authentication of the provisioner and is fenced to localhost.
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { hashPassword } from '@usrp/shared-security';
import type { Agency } from '@usrp/shared-types';

export type AdminOutcome =
  | { readonly kind: 'PROVISIONED'; readonly loginHandle: string }
  | { readonly kind: 'EXISTS'; readonly loginHandle: string }
  | { readonly kind: 'OTHER_ADMIN'; readonly existingHandles: readonly string[] };

export interface AdminRequest {
  readonly agency: Agency;
  readonly loginHandle: string;
  readonly password: string;
  readonly operatorReference: string;
  readonly correlationId: string;
}

export async function ensureAgencyAdmin(databaseUrl: string, request: AdminRequest): Promise<AdminOutcome> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const admins = await sql<{ login_handle: string }[]>`
      SELECT login_handle FROM public_core.officer_accounts
      WHERE agency = ${request.agency}::public_core.agency AND 'agency_admin' = ANY(roles)
    `;
    const handles = admins.map((row) => row.login_handle);
    if (handles.includes(request.loginHandle)) return { kind: 'EXISTS', loginHandle: request.loginHandle };
    // The function provisions only the FIRST administrator of an agency and
    // never replaces one. Respect that: a rehearsal will not add a second.
    if (handles.length > 0) return { kind: 'OTHER_ADMIN', existingHandles: handles };

    await sql.begin(async (tx) => {
      await tx`SET LOCAL SESSION AUTHORIZATION usrp_iam_provisioner`;
      await tx`
        SELECT public_core.provision_first_campaign_agency_admin(
          ${randomUUID()}::uuid,
          ${request.loginHandle},
          ${hashPassword(request.password)},
          ${request.agency}::public_core.agency,
          ${request.operatorReference},
          ${request.correlationId}
        )
      `;
    });
    return { kind: 'PROVISIONED', loginHandle: request.loginHandle };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
