import { describe, expect, it } from "vitest";
import { nextBackoffMs } from "../src/backoff.js";
import { parseOnBattery } from "../src/collectors/battery.js";
import { parseHidIdleSeconds } from "../src/collectors/idle.js";
import { probeOllama } from "../src/collectors/ollama.js";

describe("battery parser", () => {
  it("detects battery power", () => {
    expect(
      parseOnBattery(`Now drawing from 'Battery Power'\n -InternalBattery-0\t80%; discharging`),
    ).toBe(true);
  });

  it("detects AC power", () => {
    expect(parseOnBattery(`Now drawing from 'AC Power'\n -InternalBattery-0\t100%; charged`)).toBe(
      false,
    );
  });

  it("treats desktop (no battery) as not on battery", () => {
    expect(parseOnBattery("")).toBe(false);
  });
});

describe("idle parser", () => {
  it("parses HIDIdleTime nanoseconds", () => {
    const sample = `"HIDIdleTime" = 15000000000`;
    expect(parseHidIdleSeconds(sample)).toBe(15);
  });

  it("returns 0 when missing", () => {
    expect(parseHidIdleSeconds("nothing here")).toBe(0);
  });
});

describe("ollama probe", () => {
  it("returns empty lists when ollama is down", async () => {
    const snap = await probeOllama("http://127.0.0.1:9", async () => {
      throw new Error("down");
    });
    expect(snap).toEqual({ modelsLoaded: [], modelsInstalled: [] });
  });

  it("parses ps and tags", async () => {
    const snap = await probeOllama("http://ollama.test", async (url) => {
      if (String(url).endsWith("/api/ps")) {
        return new Response(JSON.stringify({ models: [{ name: "llama3:latest" }] }));
      }
      return new Response(
        JSON.stringify({ models: [{ name: "llama3:latest" }, { name: "qwen2" }] }),
      );
    });
    expect(snap.modelsLoaded).toEqual(["llama3:latest"]);
    expect(snap.modelsInstalled).toEqual(["llama3:latest", "qwen2"]);
  });
});

describe("backoff", () => {
  it("grows and caps", () => {
    expect(nextBackoffMs(0, 1000, 60_000)).toBeGreaterThanOrEqual(1000);
    expect(nextBackoffMs(10, 1000, 5000)).toBeLessThanOrEqual(5000 + 1000);
  });
});
