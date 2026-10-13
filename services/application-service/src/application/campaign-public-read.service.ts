import type {
  CampaignPublicReadRepository,
  PublicCampaign,
} from '../ports/campaign-public-read.repository.js';

export interface CampaignPublicReadDeps {
  readonly repository: CampaignPublicReadRepository;
}

export class CampaignPublicReadService {
  readonly #repository: CampaignPublicReadRepository;

  constructor(deps: CampaignPublicReadDeps) {
    this.#repository = deps.repository;
  }

  listOpen(): Promise<readonly PublicCampaign[]> {
    return this.#repository.listOpen();
  }

  findPublishedByCode(publicCode: string): Promise<PublicCampaign | null> {
    return this.#repository.findPublishedByCode(publicCode);
  }
}
