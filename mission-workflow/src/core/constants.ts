import { parseMillis } from "./time.ts";

export const DEFAULT_MAX_REPAIR_ITERATIONS = 10;
export const MAX_TEXT_BYTES = 250_000;
export const MAX_JSON_LINE_BYTES = 10_000_000;
export const MAX_USAGE_ENTRIES = 200;
export const MAX_PROMPT_CONTEXT_BYTES = 120_000;
export const GENERATED_JUNK_PATTERNS = Object.freeze([
	"__pycache__/", "*.py[cod]", ".pytest_cache/", ".venv/", "venv/", "env/", "*.egg-info/",
	".mypy_cache/", ".ruff_cache/", ".tox/", ".coverage", "coverage/", "dist/", "build/",
] as const);
export const TRANSIENT_LOCKFILE_PATHS: ReadonlySet<string> = new Set(["uv.lock"]);
export const MAX_TRANSIENT_QUARANTINE_BYTES = 5 * 1024 * 1024;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_PI_TIMEOUT_MS = parseMillis(process.env.PI_MISSION_WORKFLOW_PI_TIMEOUT_MS, 30 * 60 * 1000);
export const DEFAULT_PI_IDLE_TIMEOUT_MS = parseMillis(process.env.PI_MISSION_WORKFLOW_PI_IDLE_TIMEOUT_MS, 12 * 60 * 1000);
export const DEFAULT_COMMAND_TIMEOUT_MS = parseMillis(process.env.PI_MISSION_WORKFLOW_COMMAND_TIMEOUT_MS, 20 * 60 * 1000);
export const DEFAULT_PROCESS_TIMEOUT_MS = parseMillis(process.env.PI_MISSION_WORKFLOW_PROCESS_TIMEOUT_MS, 5 * 60 * 1000);
export const DEFAULT_GIT_TIMEOUT_MS = parseMillis(process.env.PI_MISSION_WORKFLOW_GIT_TIMEOUT_MS, 15 * 60 * 1000);
export const DEFAULT_WATCHDOG_STALE_MS = parseMillis(process.env.PI_MISSION_WORKFLOW_WATCHDOG_STALE_MS, 2 * 60 * 1000);
export const TERMINATION_GRACE_MS = parseMillis(process.env.PI_MISSION_WORKFLOW_TERMINATION_GRACE_MS, 5000);
export const ACTIVE_IO_INTERVAL_MS = parseMillis(process.env.PI_THREAD_PHASE_ACTIVE_IO_INTERVAL_MS, 5000);

export const COMPLETION_LEVELS = Object.freeze(["code_complete", "contract_validated", "operationally_ready", "deployment_ready"] as const);
export const DEFAULT_COMPLETION_TARGET = "contract_validated";
export const VALIDATION_CATEGORIES = Object.freeze(["scrutiny", "behavior", "operational", "integration", "domain", "deployment"] as const);
export const VALIDATION_SCOPES = Object.freeze(["feature", "milestone", "final"] as const);
export const VALIDATION_SKIP_POLICIES = Object.freeze(["fail_when_skipped", "explicit_skip_allowed", "optional"] as const);
export const BEHAVIOR_ADAPTERS = Object.freeze(["command", "http_flow", "browser_computer_use", "service_lifecycle", "workflow_replay"] as const);
export const FAILURE_CLASSES = Object.freeze([
	"implementation_bug", "missing_acceptance_test", "bad_plan_decomposition", "ambiguous_spec", "operational_gap",
	"external_dependency_unavailable", "credential_missing", "validator_false_positive", "model_or_handoff_failure",
	"runner_git_worktree_failure", "runner_lifecycle_failure", "capability_policy_block", "unknown",
] as const);

export const PLANNING_CLARIFICATION_SCHEMA = "pi-mission-workflow/planning-clarification/v1";
export const DEFAULT_PROMPT_POLICY = Object.freeze({
	plannerPromptVersion: "mission-planner/v3",
	workerPromptVersion: "mission-worker/v4",
	validatorPromptVersion: "mission-validator/v4",
	featureReviewPromptVersion: "mission-feature-review/v1",
	userTestingValidatorPromptVersion: "mission-user-testing-validator/v1",
	repairPlannerPromptVersion: "mission-repair-planner/v1",
	handoffSchema: "pi-mission-worker-handoff/v3",
	validationReportSchema: "pi-mission-workflow/milestone-validation/v2",
});
export const DEFAULT_CAPABILITY_POLICY = Object.freeze({
	network: "allowed_for_validation",
	secrets: "env_only_redacted",
	destructiveGit: false,
	deployment: false,
	liveExternalActions: false,
	maxCommandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
	featureReviewValidators: true,
	userTestingValidator: true,
	strategicRepairPlanner: false,
});
