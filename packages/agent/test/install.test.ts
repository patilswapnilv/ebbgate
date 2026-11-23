import { describe, expect, it } from "vitest";
import { renderLaunchAgentPlist } from "../src/install.js";
import { LAUNCH_AGENT_LABEL } from "../src/paths.js";

describe("launchd plist", () => {
  it("renders ProgramArguments for agent run", () => {
    const xml = renderLaunchAgentPlist({
      label: LAUNCH_AGENT_LABEL,
      nodeBin: "/usr/local/bin/node",
      cliPath: "/opt/ebbgate/cli.js",
      env: { EBBGATE_NODE: "mini", HOME: "/Users/test" },
    });
    expect(xml).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>/opt/ebbgate/cli.js</string>");
    expect(xml).toContain("<string>agent</string>");
    expect(xml).toContain("<string>run</string>");
    expect(xml).toContain("<string>mini</string>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<true/>");
  });

  it("escapes xml special chars in paths", () => {
    const xml = renderLaunchAgentPlist({
      label: LAUNCH_AGENT_LABEL,
      nodeBin: "/tmp/a&b",
      cliPath: "/tmp/<cli>.js",
      env: { EBBGATE_NODE: "mini" },
    });
    expect(xml).toContain("/tmp/a&amp;b");
    expect(xml).toContain("/tmp/&lt;cli&gt;.js");
  });
});
