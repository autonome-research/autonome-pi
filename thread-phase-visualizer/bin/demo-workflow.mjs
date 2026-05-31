#!/usr/bin/env node
import {
  STATUSES,
  artifact,
  completeRun,
  createRun,
  failRun,
  phaseEnd,
  phaseEvent,
  phaseStart,
} from "../lib/store.mjs";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[key] = argv[++i];
      else out[key] = true;
    } else {
      out._.push(arg);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cwd = args.cwd || process.cwd();
const workflow = args.workflow || "demo-workflow";
const shouldFail = Boolean(args.fail);
const delayMs = Number.parseInt(args.delay || "250", 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const run = createRun({
  workflow,
  cwd,
  trigger: { kind: "manual-demo" },
  input: { shouldFail, delayMs },
  message: `${workflow} demo started`,
});

try {
  phaseStart(run, "prepare", { cwd });
  await sleep(delayMs);
  phaseEvent(run, "prepare", { type: "data", key: "items", value: 3, message: "Prepared 3 demo items" });
  phaseEnd(run, "prepare", STATUSES.SUCCESS);

  phaseStart(run, "process");
  await sleep(delayMs);
  if (shouldFail) throw new Error("Intentional demo failure");
  phaseEvent(run, "process", { type: "progress", completed: 3, total: 3, message: "Processed all demo items" });
  phaseEnd(run, "process", STATUSES.SUCCESS, { completed: 3 });

  artifact(run, {
    kind: "markdown",
    title: "Demo summary",
    content: "# Demo summary\n\nThe generic thread-phase event abstraction is working.",
  });
  completeRun(run, STATUSES.SUCCESS, { ok: true });
  console.log(JSON.stringify({ ok: true, runId: run.runId, workflow, cwd }, null, 2));
} catch (error) {
  failRun(run, error);
  console.log(JSON.stringify({ ok: false, runId: run.runId, workflow, cwd, error: error.message }, null, 2));
  process.exitCode = 1;
}
