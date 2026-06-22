# Bug solver workflow examples

These examples show the normal one-bug transaction flow. Replace `/path/to/repo` and commands with project-specific values.

## 1. Read-only precheck

CLI:

```bash
node bugKill/bin/bugKill.mjs precheck \
  --cwd /path/to/repo \
  --bug "Fix login returning 500 for expired reset tokens" \
  --user-test-command "npm test -- login-reset.repro.test" \
  --validation-command "npm run lint" \
  --validation-command "npm test" \
  --allowlist "src/auth" \
  --allowlist "tests/auth" \
  --max-repairs 4 \
  --json
```

Pi tool:

```ts
bugKill({
  action: "precheck",
  cwd: "/path/to/repo",
  bug: "Fix login returning 500 for expired reset tokens",
  userTestCommand: "npm test -- login-reset.repro.test",
  validationCommands: ["npm run lint", "npm test"],
  allowlist: ["src/auth", "tests/auth"],
  maxRepairIterations: 4,
})
```

Precheck is intentionally read-only. It records a transaction plan, validation contract, approval instructions, initial allowlist policy, pending report paths, and all durable artifact paths outside the target repository under `~/.pi/agent/bugKill/transactions/<id>/` by default.

## 2. Approve and solve in an isolated transaction worktree

After reviewing `transaction-plan.json` and confirming it describes exactly one bug, activate solve:

```bash
node bugKill/bin/bugKill.mjs solve \
  --cwd /path/to/repo \
  --plan-path ~/.pi/agent/bugKill/transactions/<id>/transaction-plan.json \
  --approved \
  --implementation-command "npm run fix:login-reset" \
  --command-timeout-ms 300000 \
  --cleanup preserve \
  --json
```

Pi command and background variants:

```text
/bugKill solve --plan-path ~/.pi/agent/bugKill/transactions/<id>/transaction-plan.json --approved --background --cleanup preserve
```

```ts
bugKill({
  action: "solve",
  cwd: "/path/to/repo",
  planPath: "~/.pi/agent/bugKill/transactions/<id>/transaction-plan.json",
  approved: true,
  implementationCommand: "npm run fix:login-reset",
  commandTimeoutMs: 300000,
  cleanup: "preserve",
  background: true,
})
```

Solve refuses to edit until the approved plan is safe. It creates/reuses `bugKill/<id>` and an external worktree at the recorded base commit, runs baseline validation there, then executes implementation and bounded repair attempts only in that isolated worktree. The caller branch is never silently merged.

## 3. Inspect status and reports

```bash
node bugKill/bin/bugKill.mjs status --transaction-id <id> --json
node bugKill/bin/bugKill.mjs status --transaction-dir ~/.pi/agent/bugKill/transactions/<id> --json
```

Status is read-only and reports the latest phase, isolated worktree and branch, durable report paths, validation evidence, failure classifications, repair attempts, cleanup metadata, and terminal outcome.

## 4. Allowlist expansion before a repair attempt

If a fix legitimately needs a new path, append a justified decision before the next edit-capable attempt starts:

```bash
printf '%s\n' '{"type":"allowlist_expansion","paths":["src/session"],"justification":"The failing login reset reproduction shows expired-token session cleanup is required."}' \
  >> ~/.pi/agent/bugKill/transactions/<id>/allowlist-decisions.jsonl
```

Unjustified expansions, or expansions written after an out-of-scope edit in the same attempt, are ignored for that attempt.
