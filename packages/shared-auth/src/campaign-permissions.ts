// Campaign Control Plane permissions (BUILD-001).
//
// These are deliberately campaign-specific. They are composed with the
// existing verified officer Principal and do not grant system-wide access.

import type { Principal } from './principal.js';

export const CAMPAIGN_PERMISSIONS = [
  'campaign.create',
  'campaign.policy.create',
  'campaign.session.configure',
  'campaign.publish',
  'campaign.registration.close',
  'campaign.complete',
  'campaign.cancel',
  'campaign.read.public',
  'campaign.read.admin',
] as const;

export type CampaignPermission = (typeof CAMPAIGN_PERMISSIONS)[number];

const AGENCY_ADMIN_PERMISSIONS: ReadonlySet<CampaignPermission> = new Set([
  'campaign.create',
  'campaign.policy.create',
  'campaign.session.configure',
  'campaign.publish',
  'campaign.registration.close',
  'campaign.complete',
  'campaign.cancel',
  'campaign.read.admin',
]);

const REVIEWER_PERMISSIONS: ReadonlySet<CampaignPermission> = new Set([
  'campaign.read.admin',
]);

/** Pure role-to-permission check over the already verified officer claims. */
export function hasCampaignPermission(
  principal: Principal,
  permission: CampaignPermission,
): boolean {
  if (principal.kind !== 'officer' || permission === 'campaign.read.public') return false;
  return principal.roles.some((role) => {
    if (role === 'agency_admin') return AGENCY_ADMIN_PERMISSIONS.has(permission);
    if (role === 'reviewer') return REVIEWER_PERMISSIONS.has(permission);
    return false;
  });
}

/** Same policy at the edge, where the live officer session carries verified roles. */
export function rolesHaveCampaignPermission(
  roles: readonly string[],
  permission: CampaignPermission,
): boolean {
  if (permission === 'campaign.read.public') return false;
  return roles.some((role) => {
    if (role === 'agency_admin') return AGENCY_ADMIN_PERMISSIONS.has(permission);
    if (role === 'reviewer') return REVIEWER_PERMISSIONS.has(permission);
    return false;
  });
}
