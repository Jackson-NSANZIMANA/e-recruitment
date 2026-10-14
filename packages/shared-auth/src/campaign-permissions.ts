// Campaign Control Plane permissions (BUILD-001).
//
// These are deliberately campaign-specific. They are composed with the
// existing verified officer Principal and do not grant system-wide access.

import type { Principal } from './principal.js';

import { CAMPAIGN_PERMISSION_LIST, rolesHavePermission } from './permissions.js';

export const CAMPAIGN_PERMISSIONS = CAMPAIGN_PERMISSION_LIST;

export type CampaignPermission = (typeof CAMPAIGN_PERMISSIONS)[number];

/** Pure role-to-permission check over the already verified officer claims. */
export function hasCampaignPermission(
  principal: Principal,
  permission: CampaignPermission,
): boolean {
  if (principal.kind !== 'officer') return false;
  return rolesHavePermission(principal.roles, permission);
}

/** Same policy at the edge, where the live officer session carries verified roles. */
export function rolesHaveCampaignPermission(
  roles: readonly string[],
  permission: CampaignPermission,
): boolean {
  return rolesHavePermission(roles, permission);
}
