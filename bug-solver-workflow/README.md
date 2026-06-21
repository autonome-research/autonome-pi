# bug-solver-workflow

Persistent Pi extension scaffold for a one-bug-per-transaction solver workflow.

## Tool

`bug_solver_workflow`

Actions:

- `precheck` — read-only intake for exactly one bug. Records git/base metadata, multiplicity signals, candidate validation commands, and approval instructions in durable artifacts outside the target repository.
- `solve` — approval-gated activation surface. Requires `approved: true` and a `planPath` from precheck; later milestones will implement isolated worktree solving and bounded repairs behind this gate.
- `status` — reports the external artifact root or a specific transaction directory.

## CLI

```bash
node bug-solver-workflow/bin/bug-solver-workflow.mjs precheck \
  --cwd /path/to/repo \
  --bug "Fix login returning 500 for expired reset tokens" \
  --validation-command "npm test" \
  --json
```

After reviewing the precheck artifact and confirming it is one bug:

```bash
node bug-solver-workflow/bin/bug-solver-workflow.mjs solve \
  --cwd /path/to/repo \
  --plan-path ~/.pi/agent/bug-solver-workflow/transactions/<id>/precheck.json \
  --approved \
  --json
```

## Safety and observability

- The extension is committed source in this package tree; it does not generate its harness under `/tmp`.
- Runtime state is persisted outside the target repository under `~/.pi/agent/bug-solver-workflow/` by default.
- Workflow events use the existing generic `thread-phase-ui/v1` store with workflow name `bug-solver-workflow`; no bug-solver logic is added to the generic visualizer.
- `solve` is intentionally confirmation-gated and refuses multi-bug prechecks.
