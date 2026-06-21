# bug-solver-workflow

Persistent Pi extension scaffold for a one-bug-per-transaction solver workflow.

## Tool

`bug_solver_workflow`

Actions:

- `precheck` — read-only intake for exactly one bug. Records git/base metadata, multiplicity signals, a stable transaction plan, a durable validation contract, candidate broad validation commands, optional targeted user test command, repair budget, allowlist policy, artifact locations, evidence paths, and approval instructions outside the target repository.
- `solve` — approval-gated activation surface. Requires `approved: true` and a `planPath` from precheck; rejects multi-bug/split-required plans before any edit-capable phase. Later milestones will implement isolated worktree solving and bounded repairs behind this gate.
- `status` — reports the external artifact root or a specific transaction directory.

## CLI

```bash
node bug-solver-workflow/bin/bug-solver-workflow.mjs precheck \
  --cwd /path/to/repo \
  --bug "Fix login returning 500 for expired reset tokens" \
  --validation-command "npm test" \
  --user-test-command "npm test -- login-reset.repro.test" \
  --max-repairs 8 \
  --allowlist "src/auth" \
  --allowlist "tests/auth" \
  --json
```

After reviewing the precheck artifact and confirming it is one bug:

```bash
node bug-solver-workflow/bin/bug-solver-workflow.mjs solve \
  --cwd /path/to/repo \
  --plan-path ~/.pi/agent/bug-solver-workflow/transactions/<id>/transaction-plan.json \
  --approved \
  --json
```

## Safety and observability

- The extension is committed source in this package tree; it does not generate its harness under `/tmp`.
- Runtime state is persisted outside the target repository under `~/.pi/agent/bug-solver-workflow/` by default.
- Workflow events use the existing generic `thread-phase-ui/v1` store with workflow name `bug-solver-workflow`; no bug-solver logic is added to the generic visualizer.
- `precheck` writes `precheck.json`, `transaction-plan.json`, `validation-contract.json`, `allowlist-decisions.jsonl`, and evidence path placeholders before implementation begins.
- The transaction plan schema (`pi-bug-solver-workflow/transaction-plan/v1`) is intentionally stable: it contains exactly-one-bug status, repo/base metadata, validation/user-test commands, max repair iterations (default 8), baseline evidence metadata, allowlist policy, artifact paths, and final evidence paths.
- The validation contract schema (`pi-bug-solver-workflow/validation-contract/v1`) records explicit must-level assertions and maps each assertion to durable workflow evidence paths before any edit-capable phase.
- `solve` is intentionally confirmation-gated and refuses multi-bug prechecks/plans.
