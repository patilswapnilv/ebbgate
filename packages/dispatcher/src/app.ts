import type { EbbgateConfig } from "@ebbgate/core";
import { Hono } from "hono";
import type { AppEnv } from "./app-types.js";
import type { Db } from "./db/index.js";
import { createDemoWriter, type DemoWriter, isDemoMode } from "./demo.js";
import { createLogger, type Logger } from "./logger.js";
import type { PaperclipClient } from "./paperclip/types.js";
import { admitRoutes } from "./routes/admit.js";
import { healthzRoutes } from "./routes/healthz.js";
import { nodesRoutes } from "./routes/nodes.js";
import { presenceRoutes } from "./routes/presence.js";
import { runRoutes } from "./routes/run.js";
import { statusRoutes } from "./routes/status.js";
import { createNotifier, type Notifier } from "./services/notifier.js";
import { createPresenceService, type PresenceService } from "./services/presence.js";

export interface CreateAppOptions {
  config: EbbgateConfig;
  db: Db;
  paperclip: PaperclipClient;
  logger?: Logger;
  now?: () => Date;
  fetch?: typeof fetch;
  notifier?: Notifier;
  /** Override EG_DEMO detection; mainly for tests. */
  demo?: boolean;
  demoWrite?: DemoWriter;
}

export interface AppHandle {
  app: Hono<AppEnv>;
  presence: PresenceService;
  notifier: Notifier;
  tick: () => Promise<void>;
}

export function createApp(opts: CreateAppOptions): AppHandle {
  const logger = opts.logger ?? createLogger();
  const now = opts.now ?? (() => new Date());
  const fetchFn = opts.fetch ?? fetch;
  const demoEnabled = opts.demo ?? isDemoMode();
  const demo = createDemoWriter(demoEnabled, opts.demoWrite);
  const notifier = opts.notifier ?? createNotifier(opts.config, logger, fetchFn);
  const presence = createPresenceService({
    db: opts.db,
    config: opts.config,
    paperclip: opts.paperclip,
    notifier,
    logger,
    now,
    fetch: fetchFn,
    demo,
  });
  presence.ensureConfiguredNodes();

  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("config", opts.config);
    c.set("db", opts.db);
    c.set("paperclip", opts.paperclip);
    c.set("presence", presence);
    c.set("notifier", notifier);
    c.set("logger", logger);
    c.set("now", now);
    c.set("fetch", fetchFn);
    c.set("demo", demo);
    await next();
  });

  app.route("/", healthzRoutes());
  app.route("/", statusRoutes());
  app.route("/", presenceRoutes());
  app.route("/", nodesRoutes());
  app.route("/", runRoutes());
  app.route("/", admitRoutes());

  return {
    app,
    presence,
    notifier,
    tick: () => presence.tick(),
  };
}
