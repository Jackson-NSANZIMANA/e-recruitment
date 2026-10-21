// ══════════════════════════════════════════════════════════════════
// Version fingerprints (ADR-038) — what this edge build serves and enforces.
//
// GET /version on every service reports the commit an image was built from.
// The edge adds two fingerprints a commit SHA cannot express on its own:
//
//   contract — the operation registry, projected exactly as the evidence
//              bundle records it (scripts/evidence-bundle.mjs reads THIS
//              function from the built package), so a running edge can be
//              compared with the release evidence by one hash;
//   policy   — the role → permission map it enforces (ADR-031).
//
// PURE: derived from compiled-in tables only, never from config or requests.
// ══════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { KNOWN_ROLES, permissionsForRoles } from '@usrp/shared-auth';
import { EDGE_OPERATIONS, type EdgeOperation } from './edge-operations.js';

/** One operation as the evidence bundle and /version record it. */
export interface OperationInventoryItem {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly session: string;
  readonly permission: string | null;
  readonly csrf: boolean;
  readonly publicAllowlist: boolean;
  readonly idempotentWithoutSession: boolean;
  readonly maxBodyBytes: number;
  readonly retryOnG2G: boolean;
  readonly composition: string;
  readonly upstream: readonly string[];
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** PURE. The registry projection, sorted by operation id. */
export function operationInventory(
  operations: Readonly<Record<string, EdgeOperation>> = EDGE_OPERATIONS,
): readonly OperationInventoryItem[] {
  return Object.values(operations)
    .map((op) => ({
      id: op.operationId,
      method: op.method,
      path: op.path,
      session: op.session,
      permission: op.permission ?? null,
      csrf: op.csrf,
      publicAllowlist: op.publicAllowlist,
      idempotentWithoutSession: op.idempotentWithoutSession ?? false,
      maxBodyBytes: op.maxBodyBytes,
      retryOnG2G: op.retryOnG2G,
      composition: op.composition,
      upstream: op.upstream.map((u) => u.id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** PURE. `{ operations, sha256 }` of the operation registry. */
export function contractFingerprint(
  operations: Readonly<Record<string, EdgeOperation>> = EDGE_OPERATIONS,
): { readonly operations: number; readonly sha256: string } {
  const items = operationInventory(operations);
  return { operations: items.length, sha256: sha256(JSON.stringify(items)) };
}

/** PURE. `{ roles, sha256 }` of the role → permission map (sorted, canonical). */
export function policyFingerprint(): { readonly roles: number; readonly sha256: string } {
  const map = [...KNOWN_ROLES]
    .sort()
    .map((role) => [role, [...permissionsForRoles([role])].sort()] as const);
  return { roles: map.length, sha256: sha256(JSON.stringify(map)) };
}
