export {
  ConfigError,
  type ConfigIssue,
  configSchema,
  type DefaultRule,
  type EbbgateConfig,
  interpolateEnv,
  isDefaultRule,
  loadConfig,
  type MatchRule,
  type PolicyRule,
  parseConfig,
  validatePrivacy,
} from "./config.js";
export { decide, deriveState, resolveTier } from "./policy.js";
export * from "./types.js";
