# bug-solver-workflow

Persistent Pi extension scaffold for a one-bug-per-transaction solver workflow.

## Tool

`bug_solver_workflow`

Actions:

- `precheck` — read-only intake for exactly one bug. Records git/base metadata, multiplicity signals, a stable transaction plan, a durable validation contract, candidate broad validation commands, optional targeted user test command, repair budget, allowlist policy, artifact locations, evidence paths, and approval instructions outside the target repository.
- `solve` — approval-gated activation surface. Requires `approved: true` and a `planPath` from precheck; rejects multi-bug/split-required plans before any edit-capable phase. Later milestones will implement isolated worktree solving and bounded repairs behind this gate.
- `status` — read-only inspection of the external artifact root, a transaction id, or a transaction directory. It summarizes durable state, latest phase, report paths, isolated worktree/branch locations, failure/repair tails, and terminal outcomes without editing the target repository.

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

Inspect resumable transaction state at any time without touching the target repository:

```bash
node bug-solver-workflow/bin/bug-solver-workflow.mjs status \
  --transaction-id <id> \
  --json

node bug-solver-workflow/bin/bug-solver-workflow.mjs status \
  --transaction-dir ~/.pi/agent/bug-solver-workflow/transactions/<id> \
  --json
```

## Safety and observability

- The extension is committed source in this package tree; it does not generate its harness under `/tmp`.
- Runtime state is persisted outside the target repository under `~/.pi/agent/bug-solver-workflow/` by default.
- Workflow events use the existing generic `thread-phase-ui/v1` store with workflow name `bug-solver-workflow`; no bug-solver logic is added to the generic visualizer.
- `precheck` writes `precheck.json`, `transaction-plan.json`, `validation-contract.json`, `state.json`, `artifact-registry.json`, `allowlist-decisions.jsonl`, `implementation-evidence.jsonl`, `repair-attempts.jsonl`, `failure-classifications.jsonl`, pending `baseline-validation.json`, `reports/precheck-report.json`, and pending `final-report.json` before implementation begins. Every artifact-registry entry is marked `materialized_at_precheck` and exists on disk outside the target repository.
- The transaction state schema (`pi-bug-solver-workflow/state/v1`) records lifecycle status/phase, immutable base commit, target branch and isolated worktree metadata, validation evidence paths, repair counters, failure-classification paths, final/intermediate report paths, and the artifact registry path. Initial pending reports include summary, command, failure, repair, commit, and evidence-path sections so status/recovery never depends on not-yet-created future artifacts. The global registry at `~/.pi/agent/bug-solver-workflow/registry/transactions.json` makes each transaction recoverable by id. `status --transaction-id` uses that registry and the transaction directory to reconstruct resume/status details, including latest phase, durable reports, branch/worktree locations, and terminal outcome.
- The transaction plan schema (`pi-bug-solver-workflow/transaction-plan/v1`) is intentionally stable: it contains exactly-one-bug status, repo/base metadata, validation/user-test commands, max repair iterations (default 8), baseline evidence metadata, allowlist policy, artifact paths, state path, artifact registry path, and final evidence paths.
- The validation contract schema (`pi-bug-solver-workflow/validation-contract/v1`) records explicit must-level assertions and maps each assertion to durable workflow evidence paths before any edit-capable phase.
- `solve` is intentionally confirmation-gated and refuses multi-bug prechecks/plans, including comma-separated independent clauses such as `Fix login bug, repair billing bug`.
- M0 compatibility helpers live in `bug-solver-workflow/lib/m0-compat.mjs`; they normalize precheck/plan artifacts and assess the pre-implementation gate without mutating target repositories, so later milestones can build on the committed scaffold without changing the current CLI/API surface. The solve gate rejects recognized-schema artifacts unless they carry explicit pre-implementation approval markers: `editingAllowed: false` and `confirmationRequired: true`, plus `readOnly: true` for precheck artifacts.
