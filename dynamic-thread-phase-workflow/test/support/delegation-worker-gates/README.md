# Recursive worker compatibility gates — fixture only

**Not a workflow runner or production worker. No durable scheduler, public v3, manifest registration, real inference or auth staging is enabled.** Actual implementation used ASTRA only; no coding/review subagents were launched. Pi processes here consume deterministic local provider streams, not an external model.

## Reproduce (explicit authorization required)

From repository root, select the exact test file. The process tests skip unless `PI_DELEGATION_COMPAT_FIXTURES=1`; the driver independently rejects accidental execution without that fixture-only switch. It grants no production authority.

```bash
unset PI_DYNAMIC_WORKFLOW_BACKGROUND PI_DYNAMIC_THREAD_PHASE_BACKGROUND
repo="$PWD"
sha256sum -c /tmp/autonome-pi-paused-repair.hashes
node_bin="$(command -v node)"
scratch="$(mktemp -d /tmp/autonome-worker-validation.XXXXXX)"
mkdir -p "$scratch"/{home,agent,store,sessions,tmp}
env -i PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  HOME="$scratch/home" TMPDIR="$scratch/tmp" \
  PI_CODING_AGENT_DIR="$scratch/agent" \
  PI_CODING_AGENT_SESSION_DIR="$scratch/sessions" \
  PI_THREAD_PHASE_STORE_DIR="$scratch/store" \
  PI_DYNAMIC_WORKFLOW_BACKGROUND= PI_DYNAMIC_THREAD_PHASE_BACKGROUND= \
  PI_THREAD_PHASE_STATUS_BRIDGE=0 PI_THREAD_PHASE_TERMINAL_TITLE=0 \
  PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  PI_DYNAMIC_WORKFLOW_PI_BIN=/bin/false PI_DELEGATION_COMPAT_FIXTURES=1 \
  NODE_OPTIONS="--import=$repo/dynamic-thread-phase-workflow/test/support/delegation-worker-gates/no-network.mjs" \
  "$node_bin" --test "$repo/dynamic-thread-phase-workflow/test/delegation-worker-gates.test.mjs" \
  > "$scratch/result.tap" 2>&1
# Inspect result.tap. Fixture workers/probes clean their own exact temporary directories.
# Retain the outer scratch directory for review, then remove only that directory.
```

Do not run `npm test`, broad dynamic test globs, or `successor-repair.test.mjs` in the paused checkout. For safe regressions, append exactly:

```text
dynamic-thread-phase-workflow/test/delegation-contract.test.mjs
dynamic-thread-phase-workflow/test/delegation-budget.test.mjs
dynamic-thread-phase-workflow/test/delegation-context.test.mjs
dynamic-thread-phase-workflow/test/delegation-scope.test.mjs
dynamic-thread-phase-workflow/test/schema-contract.test.mjs
dynamic-thread-phase-workflow/test/pi-json-stream.test.mjs
```

## Demonstrated versions and provenance

Linux, Node **v24.15.0**, explicit package versions checked before execution (no fallback):

| Pi | Entrypoints exercised |
| --- | --- |
| Installed **0.85.1** | `/home/velvet/.npm-global/bin/pi` → `/home/velvet/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`; SDK at the same package's `dist/index.js` |
| Repository **0.84.2** | `node_modules/@earendil-works/pi-coding-agent/dist/cli.js` and `dist/index.js` |

The fixture invokes the installed bin symlink (the bundled CLI), and the repository's explicit unbundled JS CLI entry with the current Node and a network-denial preload, rather than relying on PATH or inherited `NODE_OPTIONS`. It does not install/update Pi. No support claim for other Pi/Node/OS versions.

- CLI enables only this directory's **explicit** `provider.ts` and `worker.ts`, plus `impostor.ts` only for a negative test. All discovery flags are disabled; `--no-approve` rejects project resource trust; generated agent settings have no package sources. Poison global/project extensions and context files do not execute/load.
- Model stream: `delegation-fixture/deterministic`, custom local `streamSimple`; dummy literal `fixture-not-real-auth`. Missing provider/FD/profile/context fails, never falls back to installed auth or another model.
- Exact root tools: `bash,grep,read,workflow_complete,workflow_context,workflow_delegate,write`. Child: `grep,read,workflow_complete,workflow_context,workflow_delegate`. Grandchild: `grep,read,workflow_complete,workflow_context`.
- Every effective tool's full expected provenance is `path: <absolute worker.ts>, source: cli, scope: temporary, origin: top-level`, with no `baseDir`. Same-name explicit impostor fails before inference. The separate SDK probe confirms allowlist filtering survives tool registration/activation refresh and distinguishes builtin provenance.
- Stock grep counterexample stages a **copy** of existing `/home/velvet/.pi/agent/bin/rg` in the temporary agent/bin. SHA256 `968cabe8efed72fd8fd482cb76b6084fcb695fc5293af7fb62296b02f487fb69`. No download or installed-file modification. Stock grep returns forbidden match text with **zero** custom `readFile` calls, on both versions.
- `no-network.mjs` denies fetch/HTTP/HTTPS/TLS/TCP and permits only fixture Unix sockets under TMPDIR. The SDK probe explicitly exercises fetch/TCP denial. This is defense-in-depth for trusted fixture code, **not** a hostile-code OS sandbox.

Built-in catalogue lookup and explicit static `models.json` model/auth-presence resolution work on both SDKs without inference. This does **not** demonstrate real credentials, provider transport, OAuth refresh, auth commands/interpolation or inferred provider configuration staging. Initial runtime should support only an explicitly reviewed built-in/static profile; dynamically discovered extension providers remain unsupported, with no fallback.

## Gate results and boundaries

| Gate | Result | Evidence / limitation |
| --- | --- | --- |
| Isolation, exact names **and provenance** | **PASS (fixture)** | Fresh per-worker HOME/agent/session/store; empty inherited background and title/status settings; no parent model/auth/session/bridge/launch env copied. Poison resources excluded. Profile checked before every model request. |
| Private bootstrap | **PASS (fixture)** | FD3 pipe consumed/closed in awaited factory; capability omitted from argv, prompt, events/results. Private directory 0700/socket 0600; first connection bound to fixture invocation. Missing FD fails. Production extra-stdio helper/host authorization not implemented. |
| Whole-batch preflight | **PASS (both versions)** | Each exclusive delegate/complete/bash paired with actual write sentinel in both orders, plus all three together; every sibling errors before any write/spawn/candidate. Ordinary read/search batches remain usable. |
| Live recursive tool continuation | **PASS (fixture)** | Root delegates, child actually delegates, grandchild completes, child reads own index and integrates, then root does likewise. Same PIDs/session IDs remain live; no parent provider turn between park and child exit/return. Provider intentionally reuses IDs; private request IDs differ by actual assistant occurrence. |
| Completion lifecycle | **PASS (fixture)** | `terminate:true` prevents another provider turn. Normal exit without candidate is not success; candidate + exit 23 remains failure. Submission is separately recorded before exit. No durable candidate/evidence/result publication. |
| Context and own-child index | **PASS (fixture)** | Required empty bootstrap index, fresh joined index after a compaction-shaped context replacement, real `workflow_context` byte-page tool reads and exact review hashes. Replacement is bounded, not growing history. Pure foundations separately cover 127-child paging. Actual SDK manual compaction emits start/end with deterministic extension-supplied usage on both versions; no summarizer inference. |
| Scoped read/search | **PASS (narrow fixture); production DEFERRED** | Custom text read and literal grep reject out-of-scope paths/links; grep traverses through its own checks, never ripgrep. Literal-only, bounded scans, no subprocesses. Not general regex/find/ls/edit/write adapters, gitignore semantics, protected-path policy, leases or hostile race protection. `write` is only a fixed exclusive-create mutation sentinel. |
| Bash routing | **PASS (adapter seam)** | Actual Pi `createBashTool` operations hook sends private `shell_execute`, not local detached bash. Fixture responder uses real `runBoundedProcess` + real `createProcessJournal.reserve/started/ended`; exact request/token/PID owned by responder. Fixed leaf `printf`, bounded returned output. Command acceptance is fixture-only. |
| Group draining/cancellation | **DEFERRED** | Fixed workers/command exit and groups disappear; no orphan descendant fixture, lane barrier, down-tree cancellation or reconnect/recovery proof. Existing helper's direct-exit cleanup must still be fixed/tested in runtime slice. |
| Errors/disconnect | **PASS (limited fixture)** | Tool throws become actual `isError`; accepted-then-disconnected fixture request reports `ACCEPTANCE_UNKNOWN`, not false nonacceptance, with no retry/new worker. Next context refresh fail-stops. No durable acceptance, epoch/reconnect/deduplication or subtree cancellation claim. |
| Usage source separation | **PASS within fixture boundaries; M1 independently closed; host integration DEFERRED** | Seven exclusive assistant messages =119 fixture tokens per tree. Actual Pi JSON passes legacy collector without counting display-only child totals, and actual store `projectRun` excludes them. SDK manual compaction source =3 separately reported mock tokens. New actual `_checkCompaction()` twice probes on both versions cover successful overflow summary followed by the no-new-start execution-failure diagnostic, retaining the 3-token source and the SDK error separately. The old 100-pass suite missed this legitimate sequence; it was not blanket usage-gate approval. Ignore cumulative updates, `agent_end`, tool usage and result/display totals; distinguish missing/partial and conflicting duplicates. Legacy collector's raw tool-usage bug is demonstrated, not globally changed. |
| Public opt-in / worker registration | **DISABLED, tested** | No public schema/manifest/host/legacy collector changes. |

**Fail-stop finding:** Pi's `session_start` and `context` exceptions are caught/logged and execution can continue. Throwing a profile/context error is not a safety gate. This private fixture uses `process.exit(70)` for failed bootstrap/profile/refresh, empirically before any provider invocation in those cases. Never load that fixture in mainchat. A production worker must have a reviewed fail-stop path, or use a narrow dedicated SDK worker entrypoint that rejects before provider dispatch. Do not weaken freshness/profile gates to accommodate ordinary exception semantics.

## Exact private compaction classifier lifecycle (M1 correction)

`exclusiveUsageObserver.observe(event)` still returns a source observation or `undefined` for ignored/duplicate events. **Interface addition:** it can return `{invocationId, identity, diagnostic}` with **no `source`, `usage` or completeness** for the later execution failure. First failed/aborted compaction source observations also carry `diagnostic`. The diagnostic is `{type: "compaction_failure", reason, aborted, willRetry, errorMessage?}`. Callers must route `diagnostic` to execution settlement and only `source` observations to accounting. Keeping reported summary usage does **not** mark the invocation successful. No host currently consumes this helper.

- A start allocates one current compaction identity. Start reason is `manual`, `threshold`, `overflow`, or omitted for minimal private fixtures; end reason must match exactly. An overlapping start before any end fails `USAGE_LIFECYCLE_AMBIGUOUS`. A start after settlement retires both current digest slots. No historical/cross-start replay is supported.
- The first end accounts exactly one source. A result object may lack usage (one missing source); an error/abort without result is one missing/partial source, with the failure retained. Reported usage with an error/abort is partial. No-result end without an error/abort, null/malformed result, top-level usage, malformed flags/error or mismatched reason fails closed. Omitted boolean flags remain supported for minimal source fixtures, not for the special later diagnostic.
- **Only** an `overflow` start followed by a result-bearing successful end (`aborted:false`, no error, `willRetry:true`) permits a later no-new-start diagnostic. That later end must have `reason:"overflow"`, **no result or usage**, `aborted:false`, `willRetry:false` and a nonempty string `errorMessage`. It adds no compaction/missing/partial count and never replaces summary usage. This also preserves a previously missing summary as missing once. Error wording is retained, not hardcoded as an English-string gate.
- Same normalized usage/completeness and lifecycle metadata at the current source identity is idempotent, even after the diagnostic. Changed token/cost/completeness or lifecycle metadata conflicts. Same diagnostic is idempotent; changed diagnostic conflicts. Summary text/details are not accounting inputs. Other repeated ends fail closed rather than treating all errors as free diagnostics. No end without a start is accepted (`USAGE_IDENTITY_MISSING`), including SDK overflow failure with an unobserved/absent summarization start.
- State is constant-space: current source/diagnostic digests, reason and one eligibility boolean; no event history, diagnostic array/map, hidden retry or new counter. Existing numeric identities/counters fail at safe-integer exhaustion (`USAGE_LIMIT`). Caller must bound parsed events and consume them in wire order; this is not a general SDK replay/reordering or crash-loss accountant.

The added SDK regression uses the **actual** dispatcher sequence from independent review on each pinned SDK, not fabricated lifecycle events. Static dummy model config, in-memory history, extension-supplied summary/usage and a throwing `agent.streamFunction` ensure no inference; it asserts `_checkCompaction` returns `true` then `false`, the exact three-event shape, saved compaction usage, and the observer's separate failure. No `prompt()` or `agent.continue()` runs. It is **not** an end-to-end real-provider overflow/retry test or recursive post-compaction integration proof. SDK probe execution independently requires the existing consent flag.

## File boundaries

- `worker/profile.mjs`: private production-intended environment/name/provenance primitives. No auth staging or launch authority.
- `worker/adapter-primitives.mjs`: private occurrence/full-batch/context-replacement/runner-bash-operations primitives. Trusted runner must validate snapshots and grants; these do not allocate or persist.
- `worker/exclusive-usage.mjs`: private single-live-invocation event classifier; bounded parsed ordered events required. Not wired to host/collector/store, not crash replay or exact billing accounting.
- Everything under **this support directory** is fixture-only. `driver.mjs` is an intentionally tiny in-memory responder with a fixed three-node path, **not a production scheduler**. Its acceptance/results/indexes have no durable safety authority. Real process-journal writes in the shell seam do not make fixture delegation durable.

Next runtime slice still needs durable admission/journal/headroom, request replay/conflict/epoch validation, group draining, scoped operations/evidence publication, parked permits/leases/deadlines/cancellation, collector integration and root-only continuation. Preserve the existing public disablement until those are independently proven.

Historical validation evidence (predates M1 correction, **not review closure**): actual installed **bundled CLI** + repository CLI focused **33/33** (0 skipped) at `/tmp/autonome-worker-bundle.ivuPMi/result.tap`. Earlier focused `/tmp/autonome-worker-validation.UL0mWf/result.tap` (33/33) and combined `/tmp/autonome-worker-final.EtegHY/result.tap` (100/100) exercised installed **unbundled** `dist/cli.js`, not its bin target; they are not substituted for the bundled-binary proof. Final combined seven-file validation against the installed **bundled** CLI and repository CLI passed **100/100**, 0 skipped, at `/tmp/autonome-worker-final-bundle.VsT9X9/result.tap`. Default (no consent flag) focused run passed **7**, skipped **26** process tests, at `/tmp/autonome-worker-default.ih2bhL/result.tap`. Full handoff is recorded in `/tmp/autonome-pi-fractal-worker-gates-progress.md`. Each full focused run launches 38 bounded CLI fixture workers plus two SDK probes (and two fixed runner bash commands/two stock-rg counterexamples); it launches no external provider or operational workflow. All generated worker/probe directories are removed after settlement.

M1 candidate suite: **41 tests** = prior 33 + **2 actual SDK overflow-dispatcher regressions** + **6 pure lifecycle/accounting edge tests**; 28 consent-gated process tests and 13 default pure tests. Each full run now uses 38 CLI workers + **4 SDK probes**, still only two fixed shell commands/two stock-rg counterexamples. M1 validation: focused **41/41** at `/tmp/autonome-worker-usage-focused.Ypwm3h/result.tap`; final seven-file **108/108** (41 compatibility +67 safe regressions) at `/tmp/autonome-worker-usage-final.bDzG7c/result.tap`, all zero failed/skipped/cancelled. Default no-consent: **13 passed /28 intentionally skipped** at `/tmp/autonome-worker-usage-default.b1wULd/result.tap`, with driver refusal asserted. Separate direct SDK probe guard rejects without consent before loading any package/config at `/tmp/autonome-worker-usage-guard.pTqVph/result.txt`. Both SDKs retain their actual terminal error text; successful accounting is not successful overflow recovery. Exact commands/audit are recorded in `/tmp/autonome-pi-fractal-worker-usage-repair.md`; independent M1 closure is **CLEAN**, with 41/41 focused and 108/108 combined tests independently passing. The closure evidence is `/tmp/autonome-pi-fractal-worker-usage-closure.md`; production integration remains deferred.
