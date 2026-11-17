import type { EbbgateConfig } from "@ebbgate/core";
import type { Db } from "./db/index.js";
import type { DemoWriter } from "./demo.js";
import type { Logger } from "./logger.js";
import type { PaperclipClient } from "./paperclip/types.js";
import type { Notifier } from "./services/notifier.js";
import type { PresenceService } from "./services/presence.js";

export type AppVariables = {
  config: EbbgateConfig;
  db: Db;
  paperclip: PaperclipClient;
  presence: PresenceService;
  notifier: Notifier;
  logger: Logger;
  now: () => Date;
  fetch: typeof fetch;
  demo: DemoWriter;
};

export type AppEnv = { Variables: AppVariables };
