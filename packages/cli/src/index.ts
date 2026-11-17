export { DETECT_DEFAULTS, detectServices } from "./detect.js";
export { type InitAnswers, renderEbbgateYaml, type Tier } from "./generate/ebbgate-yaml.js";
export { renderEnvExample } from "./generate/env-example.js";
export { renderLitellmConfig } from "./generate/litellm.js";
export { envKeyForNodeToken, generateSecret } from "./generate/secrets.js";
export {
  ExistingConfigError,
  INIT_FILES,
  type InitOptions,
  type InitResult,
  runInit,
} from "./init.js";
export { listPaperclipAgents } from "./paperclip-agents.js";
