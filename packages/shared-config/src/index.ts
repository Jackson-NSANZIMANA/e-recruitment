// ══════════════════════════════════════════════════════════════════
// @usrp/shared-config — Public API
//
//   Primitive validators + loader:
//     import { loadEnv, string, integer, port } from '@usrp/shared-config'
//
//   USRP config sections:
//     import { loadServiceConfig, loadG2GConfig } from '@usrp/shared-config'
//
//   Edge (BFF) tier only:
//     import { loadCorsConfig, loadEdgeSessionConfig } from '@usrp/shared-config'
//
//   Production boot guard — call assertProductionSecrets() as the FIRST
//   statement in every service main(), before any other loader:
//     import { assertProductionSecrets, resolveEventTransport } from '@usrp/shared-config'
// ══════════════════════════════════════════════════════════════════

export {
  EnvValidationError,
  boolean,
  deepFreeze,
  integer,
  list,
  loadEnv,
  oneOf,
  optional,
  port,
  string,
  url,
  withDefault,
  type EnvSchema,
  type EnvSource,
  type EnvSpec,
  type InferEnv,
  type StringOpts,
} from './env.js';

export {
  AGENCIES,
  LOG_LEVELS,
  NODE_ENVS,
  loadAgencyDeploymentConfig,
  loadAuthIssuerConfig,
  loadAuthVerifyConfig,
  loadCorsConfig,
  loadDatabaseConfig,
  loadEdgeSessionConfig,
  loadG2GConfig,
  loadKafkaConfig,
  loadRedisConfig,
  loadRuntimeConfig,
  loadSecurityConfig,
  loadServiceConfig,
  portEnvVarFor,
  type AgencyCode,
  type AgencyDeploymentConfig,
  type AuthIssuerConfig,
  type AuthVerifyConfig,
  type CorsConfig,
  type DatabaseConfig,
  type EdgeSessionConfig,
  type G2GConfig,
  type G2GEndpointConfig,
  type KafkaConfig,
  type LogLevel,
  type NodeEnv,
  type RedisConfig,
  type RuntimeConfig,
  type SecurityConfig,
  type ServiceConfig,
} from './config.js';

export {
  assertProductionSecrets,
  isProduction,
  resolveEventTransport,
  type EventTransport,
} from './production-guard.js';
