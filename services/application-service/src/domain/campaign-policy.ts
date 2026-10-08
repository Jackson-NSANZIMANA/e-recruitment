// Canonical policy-version hashing for BUILD-001.
//
// The hash covers the complete policy decision payload, including the shared
// legal-basis code/reference. Policy category keys are objects, and
// requiredDocumentTypes are normalized as a set before canonical JSON is made.

import type { CampaignPolicyInput } from '@usrp/shared-types';
import {
  CAMPAIGN_POLICY_HASH_VERSION as SHARED_CAMPAIGN_POLICY_HASH_VERSION,
  canonicalCampaignJson,
  hashCampaignCanonicalJson,
} from '@usrp/shared-security';

export const CAMPAIGN_POLICY_HASH_VERSION = SHARED_CAMPAIGN_POLICY_HASH_VERSION;

export function campaignPolicyHashPayload(input: CampaignPolicyInput): unknown {
  return {
    legalBasisCode: input.legalBasisCode,
    legalBasisReference: input.legalBasisReference,
    policyDocument: input.policyDocument,
  };
}

export function canonicalCampaignPolicy(input: CampaignPolicyInput): string {
  return canonicalCampaignJson(campaignPolicyHashPayload(input));
}

export function hashCampaignPolicy(input: CampaignPolicyInput): string {
  return hashCampaignCanonicalJson(campaignPolicyHashPayload(input));
}
