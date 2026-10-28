// Public API of the sandbox for tools (rehearsal) and tests. The server entry is main.ts.
export { createSandboxServer, type SandboxServerOptions } from './server.js';
export type { SandboxWorld, SimRequest, SimResponse, SimulatorId, SimulatorModule, Subject, FaultKind } from './module.js';
export { Population, kigaliReferenceDate, type PopulationOptions } from './population/population.js';
export { PERSONAS, PERSONA_IDS, LEGACY_FIXTURE_NOTES, type PersonaEntry } from './population/personas.js';
export { AUTHORITIES, BEHAVIOURS, SYNTHETIC_PHONE_PATTERN, type Authority, type BehaviourName, type SdmsResultsRecord, type SyntheticCitizen } from './population/model.js';
export { SYNTHETIC_NID_PATTERN, isSyntheticNid, maskedHint, spacedDocumentNumber, syntheticNid } from './population/nid.js';
export { validateContract, CONTRACTS, type ContractName } from './contracts.js';
export { loadPrivatePersona, enclosingGitWorkTree, PrivatePersonaRefused, type PrivatePersona } from './overlay.js';
export { createLiveNesa, type LiveNesaPassthrough } from './live-nesa.js';
export { consoleLog, silentLog, redact, type SandboxLog } from './log.js';
export { BEHAVIOUR_HEADER, DEFAULT_PROFILES, type AuthorityProfile } from './behaviour.js';
export { NIDA_IDENTITY_PATH, SUBJECT_HEADER } from './modules/nida-irembo.js';
export { SDMS_RESULTS_PATH } from './modules/nesa-sdms.js';
export { DEV_G2G_CLIENT_TOKEN } from './dev-token.js';
export { IREMBO_CERTIFICATE_PATH, APPLICATION_NUMBER_HEADER, APPLICATION_NUMBER_PATTERN, CERT_CODES } from './modules/irembo-certificates.js';
export { createSmsTwilioModule, twilioSignature, DEV_TWILIO_ACCOUNT_SID, DEV_TWILIO_AUTH_TOKEN, TWILIO_IDEMPOTENCY_HEADER, MAGIC_UNDELIVERED, MAGIC_OPTED_OUT, type SmsTwilioModule, type SmsTwilioOptions } from './modules/sms-twilio.js';
export { buildModules } from './modules/index.js';
export { CERTIFICATE_APPLICATION_CODES, type CertificateKind, type SandboxCertificate } from './population/model.js';
