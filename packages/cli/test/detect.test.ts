import { describe, expect, it } from "vitest";
import { detectServices } from "../src/detect.js";
import { listPaperclipAgents } from "../src/paperclip-agents.js";

describe("detectServices", () => {
  it("returns nulls when nothing is listening", async () => {
    const d = await detectServices(async () => {
      throw new Error("down");
    }, 50);
    expect(d).toEqual({ ollama: null, litellm: null, paperclip: null });
  });

  it("records URLs that respond", async () => {
    const d = await detectServices(async (url) => {
      const u = String(url);
      if (u.includes(":11434")) return new Response("{}", { status: 200 });
      if (u.includes(":4000")) return new Response("{}", { status: 200 });
      return new Response("nope", { status: 503 });
    }, 50);
    expect(d.ollama).toBe("http://127.0.0.1:11434");
    expect(d.litellm).toBe("http://127.0.0.1:4000");
    expect(d.paperclip).toBeNull();
  });
});

describe("listPaperclipAgents", () => {
  it("parses array payloads", async () => {
    const agents = await listPaperclipAgents(
      "http://paperclip.test",
      "key",
      "co-1",
      async () =>
        new Response(JSON.stringify([{ id: "a1", name: "Inbox" }, { id: "a2" }]), {
          status: 200,
        }),
    );
    expect(agents).toEqual([{ id: "a1", name: "Inbox" }, { id: "a2" }]);
  });

  it("returns empty on failure", async () => {
    const agents = await listPaperclipAgents("http://paperclip.test", "key", "co-1", async () => {
      throw new Error("nope");
    });
    expect(agents).toEqual([]);
  });
});
