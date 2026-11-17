import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test workspace packages from source, so tests never depend on a prior build.
    alias: {
      "@ebbgate/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@ebbgate/agent": fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
      "@ebbgate/cli": fileURLToPath(new URL("./packages/cli/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
