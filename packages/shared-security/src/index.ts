// ══════════════════════════════════════════════════════════════════
// @usrp/shared-security — Public API
//
// Cryptographic primitives shared by all USRP services. Keys are passed
// in explicitly (this package never reads config) so it stays pure and
// trivially testable.
// ══════════════════════════════════════════════════════════════════

export { canonicalJson, type JsonValue } from './canonical.js';

export {
  InvalidNationalIdError,
  canonicalHash,
  hashNationalId,
  hashPhoneNumber,
  hmacSha256Hex,
  isValidRwandanNationalId,
  sha256Hex,
  timingSafeEqualHex,
} from './hashing.js';

export {
  computeFieldPayloadHash,
  generateDeviceKeyPair,
  signEd25519,
  signFieldScoreRecord,
  signSlotInvitation,
  verifyEd25519,
  verifyFieldScoreRecord,
  verifySlotInvitation,
  type Ed25519KeyPairPem,
  type FieldSignature,
  type SignableFieldPayload,
  type VerifySlotInvitationOptions,
} from './signing.js';

export {
  DEFAULT_G2G_MAX_SKEW_MS,
  signG2GRequest,
  verifyG2GRequest,
  type G2GRequestParams,
  type G2GSignedHeaders,
  type G2GVerifyOptions,
} from './g2g.js';

export { DecryptionError, aesGcmDecrypt, aesGcmEncrypt } from './encryption.js';
