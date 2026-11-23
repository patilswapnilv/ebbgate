export {
  type AdmissionInput,
  type AdmissionResult,
  type AdmissionTarget,
  admissionTier,
  decideAdmission,
} from "./admission.js";
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
export {
  PRESENCE_LIMITS,
  type PresenceReportResult,
  parsePresenceReport,
  presenceReportSchema,
} from "./presence.js";
export * from "./types.js";
