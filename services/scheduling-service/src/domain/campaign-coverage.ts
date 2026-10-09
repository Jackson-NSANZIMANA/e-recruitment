// Re-export the shared canonical coverage-set hash for the scheduling domain.
// This prevents application-service publication and scheduling-service writes
// from implementing different byte encodings or sort orders.

export {
  CAMPAIGN_COVERAGE_HASH_VERSION,
  campaignCoverageHash,
  type CampaignCoverageSessionValue as CampaignCoverageSession,
} from '@usrp/shared-security';
