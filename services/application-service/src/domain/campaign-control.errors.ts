export class CampaignCommandError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CampaignCommandError';
    this.status = status;
    this.code = code;
  }
}

export class CampaignPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CampaignPersistenceError';
  }
}

export class CampaignReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CampaignReadError';
  }
}
