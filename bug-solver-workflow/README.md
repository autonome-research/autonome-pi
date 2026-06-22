# bug-solver-workflow

Persistent Pi extension scaffold for a one-bug-per-transaction solver workflow.

## Tool

`bug_solver_workflow`

Actions:

- `precheck` — read-only intake for exactly one bug. Records git/base metadata, dirty-worktree signals, a read-only audit, multiplicity signals, a stable transaction plan, a durable validation contract, candidate broad validation commands, optional targeted user test command, repair budget, allowlist policy, artifact locations, evidence paths, and approval instructions outside the target repository.
- `solve` — approval-gated activation surface. Requires `approved: true` and a `planPath` from precheck; rejects multi-bug/split-required plans, plans not preserving `editingAllowed=false`, dirty precheck/caller worktrees, base-HEAD mismatches, missing immutable base metadata, missing or unmapped validation contracts, in-repository/missing artifact paths, unmaterialized artifact registries, and unsafe plan schemas before any edit-capable phase. On success it writes a durable `activation-gate.json` record, creates/reuses an isolated transaction branch plus external git worktree rooted at the recorded base commit, then runs baseline validation in that unmodified transaction-base worktree before implementation. The optional targeted user test command is executed first, followed by broad validation commands; bounded stdout/stderr/status metadata is written to `evidence/baseline-validation.json`, and failures at this point are classified as pre-existing in `failure-classifications.jsonl`. After baseline, solve always enters an edit-capable implementation phase in the isolated transaction worktree (optionally via `--implementation-command` / `implementationCommand`) before post-change validation. Immediately before invoking the implementation routine, it refreshes durable `evidence/implementation-context.json` and passes the same context through environment variables: bug description, validation contract path, baseline evidence path, allowlist decision path/policy, and required evidence paths. That phase appends runner-owned `implementation-evidence.jsonl` records with before/after worktree git state, changed files, command status, worker context path, and evidence paths. Post-change validation uses the same targeted-to-broad order, writes `evidence/post-change-validation.json`, compares every command against baseline evidence, and records fixed failures, unchanged pre-existing failures, and newly regressed failures in the final report. Outcome-based final verification is reproduction- and implementation-aware: `bugFixed=true` requires a targeted bug reproduction/user test that reproduced the bug in baseline (for example by failing), then passes after validation, plus durable implementation/repair evidence that the isolated transaction worktree changed after baseline or a trusted implementation/repair phase recorded an explicit bug resolution after baseline tied to the isolated worktree change/commit in `implementation-evidence.jsonl`; explicit resolution records are not trusted from claims alone—their claimed changed files or commit must be corroborated by actual isolated-worktree git diff/status/HEAD evidence after baseline, unless the record carries runner-owned implementation/repair metadata that validation commands cannot produce. Pre-existing, manually injected, or validation-command-written resolution lines are ignored for `implementationBacked`. If the targeted command already passed at baseline, final verification is inconclusive/not_reproduced, and if no trusted implementation evidence exists it is inconclusive/not_implemented rather than successful from exit codes alone. When no targeted command is provided, verification remains inconclusive for bug-fix proof even if no new regressions are observed. Implementation must run in the isolated worktree, never by editing the caller worktree directly.
- `status` — read-only inspection of the external artifact root, a transaction id, or a transaction directory. It summarizes durable state, latest phase, report paths, isolated worktree/branch locations, failure/repair tails, and terminal outcomes without editing the target repository.

## CLI

```bash
node bug-solver-workflow/bin/bug-solver-workflow.mjs precheck \
  --cwd /path/to/repo \
  --bug "Fix login returning 500 for expired reset tokens" \
  --validation-command "npm test" \
  --validation-command "npm run lint; npm run typecheck" \
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
  --implementation-command 'npm run fix:targeted-bug' \
  --json
```

Pass each broad validation command as its own repeated `--validation-command` flag. The workflow stores and executes each flag value atomically, so shell punctuation inside a command (for example `;`, `&&`, pipes, or commas in arguments) is preserved for both baseline and post-change validation instead of being treated as a command separator.

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
- `precheck` materialization is interruption-safe: it takes a per-transaction lock with atomic create semantics, writes a `.precheck-incomplete.json` marker while staging artifacts, verifies every registered artifact exists, then writes `artifact-registry.json` last and clears the marker. If interrupted, `status --transaction-id` reports the incomplete marker/missing files and a retry preserves the immutable transaction identity (base commit, branch name, and isolated worktree path). Empty, malformed, or dead-pid legacy `.precheck.lock` files are reported as recoverable stale locks by `status` and are safely replaced by the next retry instead of blocking or corrupting state. A completed precheck writes `precheck.json`, `transaction-plan.json`, `validation-contract.json`, `state.json`, `artifact-registry.json`, `allowlist-decisions.jsonl`, pending `implementation-context.json`, `implementation-evidence.jsonl`, `repair-attempts.jsonl`, `failure-classifications.jsonl`, pending `baseline-validation.json`, pending `post-change-validation.json`, `reports/precheck-report.json`, and pending `final-report.json` before implementation begins. Every artifact-registry entry is marked `materialized_at_precheck` and exists on disk outside the target repository.
- The transaction state schema (`pi-bug-solver-workflow/state/v1`) records lifecycle status/phase, immutable base commit, target branch and isolated worktree metadata, validation evidence paths, repair counters, failure-classification paths, final/intermediate report paths, and the artifact registry path. Initial pending reports include summary, command, failure, repair, commit, and evidence-path sections so status/recovery never depends on not-yet-created future artifacts. The global registry at `~/.pi/agent/bug-solver-workflow/registry/transactions.json` makes each transaction recoverable by id. `status --transaction-id` uses that registry and the transaction directory to reconstruct resume/status details, including latest phase, durable reports, branch/worktree locations, worktree cleanup/reuse metadata, and terminal outcome.
- The transaction plan schema (`pi-bug-solver-workflow/transaction-plan/v1`) is intentionally stable: it contains exactly-one-bug status, repo/base metadata, parsed dirty-worktree signals (`dirtyAtPrecheck`, `cleanAtPrecheck`), validation/user-test commands, max repair iterations (default 8), baseline evidence metadata, allowlist policy, artifact paths, state path, artifact registry path, and final evidence paths.
- When an allowlist is configured, solve evaluates implementation changes against the current adaptive allowlist before accepting implementation evidence. Changes outside the current allowlist are recorded as `out_of_scope_change_rejected` in `allowlist-decisions.jsonl`, reported in implementation evidence and final-report decisions, and are not counted as implementation-backed bug fixes. To expand scope, append a durable JSONL decision such as `{ "type": "allowlist_expansion", "paths": ["src/auth"], "justification": "Required by the failing reproduction" }` to the transaction's `allowlist-decisions.jsonl` before the implementation phase accepts the change. Expansions without a non-empty justification are ignored.
- Every actionable failure is classified with a stable `category` plus human `categoryLabel` and evidence paths in `failure-classifications.jsonl`, `state.json`, and final/intermediate reports where applicable. Categories are `precheck_plan` (`precheck/plan`), `command_validation`, `targeted_reproduction`, `implementation`, `allowlist`, `git_worktree`, `lifecycle`, and `final_verification`, so recovery can distinguish unsafe plans, validation-command failures, reproduced targeted bugs, implementation command failures, scope violations, worktree/git integrity problems, runner lifecycle errors, and outcome-verification failures.
- Implementation command failures, allowlist rejections, newly regressed validation commands, and failed outcome verification enter a bounded repair loop. Each repair attempt is appended to `repair-attempts.jsonl`, linked from implementation evidence and final reports, and revalidated before another attempt is considered. The loop stops at `maxRepairIterations`; when the cap is reached, the workflow records `repair_cap_reached` / `terminal_failure_repair_cap_reached` evidence instead of retrying indefinitely.
- The validation contract schema (`pi-bug-solver-workflow/validation-contract/v1`) records explicit must-level assertions and maps each assertion to durable workflow evidence paths before any edit-capable phase. The pre-implementation contract covers single-bug scope, durable external state, contract/evidence creation, isolated transaction worktrees, baseline comparison, targeted-before-broad validation order, adaptive allowlist justifications, failure classification, capped repairs, outcome-based final verification, reviewable transaction output, durable reports, robustness/recovery, API/CLI/build integration, automated safety tests, and docs/examples.
- `solve` is intentionally confirmation-gated and refuses multi-bug prechecks/plans, including comma-separated independent clauses such as `Fix login bug, repair billing bug`. It also refuses activation if the precheck recorded dirty worktree signals, if the caller worktree is dirty at activation time, if caller `HEAD` differs from the recorded base commit, if immutable state/base metadata disagrees, if the validation contract is absent or lacks durable evidence mappings, or if any plan/registry/evidence path is missing or resolves inside the target repository. Passing the gate creates or reuses `bug-solver/<transaction>` at the recorded base and an external worktree under the bug-solver artifact root, records `activation-gate.json` and `worktree-metadata.json`, verifies the caller worktree status stayed unchanged, and preserves cleanup commands/reuse decisions durably for review or resume.
- M0 compatibility helpers live in `bug-solver-workflow/lib/m0-compat.mjs`; they normalize precheck/plan artifacts and assess the pre-implementation gate without mutating target repositories, so later milestones can build on the committed scaffold without changing the current CLI/API surface. The solve gate rejects recognized-schema artifacts unless they carry explicit pre-implementation approval markers: `editingAllowed: false` and `confirmationRequired: true`, plus `readOnly: true` for precheck artifacts.
