// ══════════════════════════════════════════════════════════════════
// @usrp/shared-config — Public API
//
//   Primitive validators + loader:
//     import { loadEnv, string, integer, port } from '@usrp/shared-config'
//
//   USRP config sections:
//     import { loadServiceConfig, loadG2GConfig } from '@usrp/shared-config'
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
  LOG_LEVELS,
  NODE_ENVS,
  loadAuthIssuerConfig,
  loadAuthVerifyConfig,
  loadDatabaseConfig,
  loadG2GConfig,
  loadKafkaConfig,
  loadRedisConfig,
  loadRuntimeConfig,
  loadSecurityConfig,
  loadServiceConfig,
  type AuthIssuerConfig,
  type AuthVerifyConfig,
  type DatabaseConfig,
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
