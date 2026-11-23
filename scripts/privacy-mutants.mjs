#!/usr/bin/env node
// Test the tests: deliberately break each privacy defence in the source, one at
// a time, and check that the privacy-guarantee suite fails. A mutant that
// survives means a defence is no longer covered. Every file is restored, even
// on Ctrl-C or a crash.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MUTANTS = [
  {
    name: "runtime guard only blocks the literal 'private' tier",
    file: "packages/core/src/policy.ts",
    from: 'if (decision.action === "cloud" && !mayRunInCloud(task.tier)) {',
    to: 'if (decision.action === "cloud" && task.tier === "private") {',
  },
  {
    name: "runtime guard removed",
    file: "packages/core/src/policy.ts",
    from: 'if (decision.action === "cloud" && !mayRunInCloud(task.tier)) {',
    to: "if (false) {",
  },
  {
    name: "config privacy validation removed",
    file: "packages/core/src/config.ts",
    from: "    ...validatePrivacy(result.data.policies),",
    to: "",
  },
  {
    name: "node runner may equal the cloud runner",
    file: "packages/core/src/config.ts",
    from: "    ...validateRunnerSeparation(result.data),",
    to: "",
  },
  {
    name: "unknown agents default to public",
    file: "packages/core/src/policy.ts",
    from: 'if (typeof agentId !== "string" || !Object.hasOwn(config.agents, agentId)) return "private";',
    to: 'if (typeof agentId !== "string" || !Object.hasOwn(config.agents, agentId)) return "public";',
  },
  {
    name: "future-dated heartbeats count as fresh",
    file: "packages/core/src/policy.ts",
    from: 'if (ageMs < -windowMs) return "offline";',
    to: "",
  },
  {
    name: "issue-level private flag ignored by admission",
    file: "packages/core/src/admission.ts",
    from: '  if (input.issuePrivate) return "private";',
    to: "",
  },
  {
    name: "missing agent id admitted with the configured default",
    file: "packages/core/src/admission.ts",
    from: '  if (!input.agentId) return "private";',
    to: '  if (!input.agentId) return "public";',
  },
  {
    name: "ebbgate admit trusts the dispatcher's remote admit blindly",
    file: "packages/cli/src/admit.ts",
    from: 'r.admit === true &&\n      args.target.kind === "remote"',
    to: 'false &&\n      args.target.kind === "remote"',
  },
  {
    name: "recovery keeps the agent's tier when the stored payload cannot be parsed",
    file: "packages/dispatcher/src/services/presence.ts",
    from: '      tier = "private";\n    }',
    to: "    }",
  },
  {
    name: "cloud forwards carry the dispatcher's shared secret",
    file: "packages/dispatcher/src/services/runner.ts",
    from: 'if (auth && opts.forwardAuthorization !== false) out.set("authorization", auth);',
    to: 'if (auth) out.set("authorization", auth);',
  },
];

const originals = new Map();
function restoreAll() {
  for (const [file, text] of originals) writeFileSync(file, text);
}
process.on("SIGINT", () => {
  restoreAll();
  process.exit(130);
});

let survived = 0;
try {
  for (const m of MUTANTS) {
    const text = originals.get(m.file) ?? readFileSync(m.file, "utf8");
    originals.set(m.file, text);
    if (!text.includes(m.from)) {
      console.error(`✗ mutant "${m.name}": anchor not found in ${m.file} (update this script)`);
      survived++;
      continue;
    }
    writeFileSync(m.file, text.replace(m.from, m.to));
    const run = spawnSync("pnpm", ["exec", "vitest", "run", "privacy"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(m.file, text);
    if (run.status === 0) {
      console.error(`✗ mutant survived: ${m.name}`);
      survived++;
    } else {
      console.log(`✓ mutant killed: ${m.name}`);
    }
  }
} finally {
  restoreAll();
}

if (survived > 0) {
  console.error(
    `\n${survived} of ${MUTANTS.length} mutants survived: the privacy suite has a gap.`,
  );
  process.exit(1);
}
console.log(`\nAll ${MUTANTS.length} mutants killed: every privacy defence is covered by a test.`);
