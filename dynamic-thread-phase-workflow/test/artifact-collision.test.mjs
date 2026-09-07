import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cli = join(root, "dynamic-thread-phase-workflow/bin/dynamic-thread-phase-workflow.mjs");

function terminalJson(stdout) {
  const start = stdout.lastIndexOf("\n{");
  return JSON.parse(stdout.slice(start < 0 ? 0 : start + 1));
}

function runWorkflow(temp, spec, options = {}) {
  const specFile = join(temp, `spec-${Math.random()}.json`);
  const store = join(temp, "store");
  if (!options.harness) writeFileSync(specFile, JSON.stringify(spec));
  const input = options.harness ? ["--harness-file", options.harness, "--permissions", "rwx"] : ["--spec-file", specFile];
  const result = spawnSync(process.execPath, [cli, ...input, "--cwd", temp, ...(options.legacy ? ["--legacy-spec"] : [])], {
    cwd: root,
    env: {
      ...process.env,
      PI_THREAD_PHASE_STORE_DIR: store,
      PI_DYNAMIC_WORKFLOW_BACKGROUND: "",
      PI_DYNAMIC_THREAD_PHASE_BACKGROUND: "",
      ...(options.pi ? { PI_DYNAMIC_WORKFLOW_PI_BIN: options.pi } : {}),
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const runId = terminalJson(result.stdout).runId;
  const artifactDir = join(store, "artifacts", runId);
  const events = readFileSync(join(store, "runs", `${runId}.jsonl`), "utf8")
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const emittedTextPaths = events
    .filter((event) => event.type === "artifact" && event.artifact?.metadata?.phase)
    .map((event) => event.artifact.path);
  return { artifactDir, emittedTextPaths };
}

function assertDistinctContents(paths, expected) {
  assert.equal(new Set(paths).size, expected.length, "artifact events must emit distinct paths");
  const contents = paths.map((path) => readFileSync(path, "utf8"));
  for (const value of expected) assert.ok(contents.includes(value), `missing retained artifact content: ${value}`);
}

function makeMockPi(temp) {
  const file = join(temp, "mock-pi.mjs");
  writeFileSync(file, `#!/usr/bin/env node
const index = process.argv.indexOf("-p");
const text = process.argv[index + 1] || "missing prompt";
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "mock", stopReason: "stop", usage: { input: 1, output: 1 }, content: [{ type: "text", text }] } }));
`);
  chmodSync(file, 0o755);
  return file;
}

test("v2 artifact defaults retain punctuation and truncation-colliding outputs", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-artifact-collision-"));
  try {
    const prefix = "long".repeat(24);
    const expected = ["punctuation colon", "punctuation dash", "long colon", "long dash"];
    const { artifactDir, emittedTextPaths } = runWorkflow(temp, {
      name: "artifact-collisions",
      permissions: "r",
      phases: [
        { type: "artifact", name: "report:a", content: expected[0] },
        { type: "artifact", name: "report-a", content: expected[1] },
        { type: "artifact", name: `${prefix}:a`, content: expected[2] },
        { type: "artifact", name: `${prefix}-a`, content: expected[3] },
      ],
    });

    assertDistinctContents(emittedTextPaths, expected);
    assert.equal(new Set(emittedTextPaths.map((path) => basename(path))).size, expected.length);
    const checkpoint = JSON.parse(readFileSync(join(artifactDir, "workflow-checkpoint.json"), "utf8"));
    assert.equal(checkpoint.completed.length, expected.length);
    assert.deepEqual(
      checkpoint.completed.map((entry) => readFileSync(join(artifactDir, entry.outputFile), "utf8")),
      expected,
      "collision-safe display artifacts must not disturb checkpoint output integrity",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("digest paths cannot shadow ordinary phase filenames", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-digest-shadow-"));
  try {
    const digest = createHash("sha256").update("report:a").digest("hex").slice(0, 24);
    const expected = ["colon", "dash", "digest shadow"];
    const { emittedTextPaths } = runWorkflow(temp, {
      name: "digest-shadow",
      permissions: "r",
      phases: [
        { type: "artifact", name: "report:a", content: expected[0] },
        { type: "artifact", name: "report-a", content: expected[1] },
        { type: "artifact", name: `report-a-${digest}`, content: expected[2] },
      ],
    });
    assertDistinctContents(emittedTextPaths, expected);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("fanout identities cannot alias through concatenated labels or shadow an ordinary path", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-fanout-identity-"));
  try {
    const itemHash = (item) => createHash("sha256").update(`0\0${item}`).digest("hex").slice(0, 10);
    const secondItem = "second";
    const firstItem = `first-0-${itemHash(secondItem)}-${secondItem}`;
    const firstPhase = "fanout";
    const secondPhase = `${firstPhase}-0-${itemHash(firstItem)}-first`;
    const joinedIdentity = `${firstPhase}-0-${itemHash(firstItem)}-${firstItem}`;
    assert.equal(joinedIdentity, `${secondPhase}-0-${itemHash(secondItem)}-${secondItem}`);
    const digest = createHash("sha256").update(JSON.stringify(["fanout", firstPhase, 0, firstItem])).digest("hex").slice(0, 24);
    const expected = [firstItem, secondItem, "ordinary path"];
    const { emittedTextPaths } = runWorkflow(temp, {
      name: "fanout-identity",
      permissions: "r",
      phases: [
        { type: "fanout", name: firstPhase, items: [firstItem], prompt: "{{item}}" },
        { type: "fanout", name: secondPhase, items: [secondItem], prompt: "{{item}}" },
        { type: "artifact", name: `${joinedIdentity.slice(0, 56)}-${digest}`, content: expected[2] },
      ],
    }, { pi: makeMockPi(temp) });
    assertDistinctContents(emittedTextPaths, expected);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("v2 agent defaults retain both punctuation-colliding outputs", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-agent-collision-"));
  try {
    const pi = makeMockPi(temp);
    const expected = ["agent colon", "agent dash"];
    const { emittedTextPaths } = runWorkflow(temp, {
      name: "agent-collisions",
      permissions: "r",
      phases: [
        { type: "agent", name: "report:a", prompt: expected[0] },
        { type: "agent", name: "report-a", prompt: expected[1] },
      ],
    }, { pi });
    assertDistinctContents(emittedTextPaths, expected);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("legacy shell defaults are collision-safe while explicit filenames remain unchanged", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-shell-collision-"));
  try {
    const prefix = "shell".repeat(20);
    const { emittedTextPaths } = runWorkflow(temp, {
      schema: "pi-dynamic-workflow/v1",
      name: "legacy-shell-collisions",
      permissions: "rwx",
      phases: [
        { type: "shell", name: `${prefix}:a`, command: "printf shell-colon", artifact: true },
        { type: "shell", name: `${prefix}-a`, command: "printf shell-dash", artifact: true },
        { type: "shell", name: "explicit", command: "printf explicit-content", artifact: { fileName: "legacy-explicit.md" } },
      ],
    }, { legacy: true });
    assert.equal(new Set(emittedTextPaths).size, 3);
    assert.ok(emittedTextPaths.some((path) => basename(path) === "legacy-explicit.md"));
    const combined = emittedTextPaths.map((path) => readFileSync(path, "utf8")).join("\n");
    for (const value of ["shell-colon", "shell-dash", "explicit-content"]) assert.match(combined, new RegExp(value));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("runtime harness artifacts preserve colliding, repeated and generated-looking names", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-harness-artifacts-"));
  try {
    const digest = createHash("sha256").update("report-a").digest("hex").slice(0, 24);
    const entries = [
      { name: "report:a" },
      { name: "report-a" },
      { name: `report-a-${digest}` },
      { name: `${"long".repeat(24)}:a` },
      { name: `${"long".repeat(24)}-a` },
      { name: "same" }, { name: "same" }, { name: "same" },
      { title: "title:a" }, { title: "title-a" },
      { name: "plain" },
      { name: "explicit", fileName: "custom.md" },
      { name: "custom" },
    ];
    const expected = entries.map((_, index) => `retained harness artifact ${index}`);
    const harness = join(temp, "harness.mjs");
    writeFileSync(harness, `export default async function(ctx) {
      const entries = ${JSON.stringify(entries)};
      const contents = ${JSON.stringify(expected)};
      for (let i = 0; i < entries.length; i++) {
        await ctx.artifact(entries[i].title || "Harness artifact", contents[i], entries[i]);
      }
    }`);
    const { emittedTextPaths } = runWorkflow(temp, undefined, { harness });
    assertDistinctContents(emittedTextPaths, expected);
    assert.ok(emittedTextPaths.some((path) => basename(path) === "plain.md"), "ordinary unused paths remain stable");
    assert.ok(emittedTextPaths.some((path) => basename(path) === "custom.md"), "explicit filenames retain their path behavior");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("fanout output paths stay distinct when long phase names would truncate item identity", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-fanout-collision-"));
  try {
    const pi = makeMockPi(temp);
    const phaseName = `fanout-${"x".repeat(100)}`;
    const expected = ["fanout first", "fanout second"];
    const { emittedTextPaths } = runWorkflow(temp, {
      name: "fanout-collisions",
      permissions: "r",
      phases: [{ type: "fanout", name: phaseName, items: expected, prompt: "{{item}}", concurrency: 2 }],
    }, { pi });
    assertDistinctContents(emittedTextPaths, expected);
    assert.equal(readdirSync(join(temp, "store", "artifacts")).length, 1);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
