// One-time, operator-run first agency_admin provisioning for BUILD-001.
//
// This intentionally has no HTTP route and cannot promote/replace an existing
// administrator. The operator supplies an externally authorized change/ticket
// reference, a secure password via environment, and an explicit confirmation.
// The narrow database function atomically inserts the account and a safe
// AUDIT_ENTRY outbox envelope; this script never prints the login handle,
// password, credential digest, or raw database error.
//
// Required environment:
//   FIRST_ADMIN_AGENCY=RDF|RNP|RCS
//   FIRST_ADMIN_LOGIN_HANDLE=<operator-assigned handle>
//   FIRST_ADMIN_PASSWORD=<secure secret from the approved secret channel>
//   FIRST_ADMIN_OPERATOR_REFERENCE=<opaque operator/change reference>
//   FIRST_ADMIN_CORRELATION_ID=<change/ticket reference>
//   CONFIRM_FIRST_ADMIN_PROVISIONING=AUTHORIZED
//
// Run with: pnpm --filter @usrp/iam-service provision:first-campaign-admin

import { randomUUID } from 'node:crypto';
import { sql } from '@usrp/shared-database';
import { hashPassword } from '@usrp/shared-security';
import type { Agency } from '@usrp/shared-types';

const AGENCIES: readonly Agency[] = ['RDF', 'RNP', 'RCS'];
const REFERENCE_RE = /^[A-Za-z0-9._:-]{3,128}$/;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

function validateText(name: string, value: string, max: number): string {
  if (value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} has an invalid length or control character`);
  }
  return value;
}

async function main(): Promise<void> {
  if (process.env['CONFIRM_FIRST_ADMIN_PROVISIONING'] !== 'AUTHORIZED') {
    throw new Error('explicit operator confirmation is required');
  }
  const agencyValue = requiredEnv('FIRST_ADMIN_AGENCY');
  if (!AGENCIES.includes(agencyValue as Agency)) throw new Error('FIRST_ADMIN_AGENCY is not a supported agency');
  const agency = agencyValue as Agency;
  const loginHandle = validateText('FIRST_ADMIN_LOGIN_HANDLE', requiredEnv('FIRST_ADMIN_LOGIN_HANDLE'), 128);
  const password = process.env['FIRST_ADMIN_PASSWORD'];
  if (password === undefined || password.length < 16 || password.length > 1024) {
    throw new Error('FIRST_ADMIN_PASSWORD must contain 16..1024 characters');
  }
  const operatorReference = requiredEnv('FIRST_ADMIN_OPERATOR_REFERENCE');
  const correlationId = requiredEnv('FIRST_ADMIN_CORRELATION_ID');
  if (!REFERENCE_RE.test(operatorReference) || !REFERENCE_RE.test(correlationId)) {
    throw new Error('operator and correlation references must be 3..128 safe reference characters');
  }

  const officerId = randomUUID();
  const credential = hashPassword(password);
  const result = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE ${sql('usrp_iam_service')}`;
    const rows = await tx<{ result: unknown }[]>`
      SELECT public_core.provision_first_campaign_agency_admin(
        ${officerId}::uuid,
        ${loginHandle},
        ${credential},
        ${agency}::public_core.agency,
        ${operatorReference},
        ${correlationId}
      ) AS result
    `;
    return rows[0]?.result;
  });

  console.log(JSON.stringify({
    status: 'first_agency_admin_provisioned',
    officerId,
    agency,
    correlationId,
    result,
  }));
  await sql.end({ timeout: 5 });
}

main().catch(async (error: unknown) => {
  const code = error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { readonly code: unknown }).code)
    : 'PROVISIONING_FAILED';
  console.error(JSON.stringify({ status: 'first_agency_admin_provisioning_failed', code }));
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exitCode = 1;
});
