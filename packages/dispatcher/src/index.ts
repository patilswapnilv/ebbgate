import { isEntrypoint } from "./main.js";
import { runMain } from "./start.js";

export { createApp } from "./app.js";
export { openDb } from "./db/index.js";
export { type DemoOptions, type DemoResult, demoConfig, runDemo } from "./demo-scenario.js";
export { isEntrypoint } from "./main.js";
export { createHttpPaperclipClient } from "./paperclip/client.js";
export { ParseError, parseRun } from "./paperclip/parse.js";
export type { PaperclipClient, TaskContextInput } from "./paperclip/types.js";
export { listen } from "./serve.js";
export {
  type DispatcherServer,
  ensureDbDir,
  formatStartupError,
  runMain,
  startDispatcher,
} from "./start.js";

if (isEntrypoint(import.meta.url)) {
  void runMain().then((result) => {
    if (result.code !== 0) process.exit(result.code);
    const { server } = result;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        void server.shutdown().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
    }
  });
}
