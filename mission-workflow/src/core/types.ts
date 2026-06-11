import type { BEHAVIOR_ADAPTERS, COMPLETION_LEVELS, FAILURE_CLASSES, VALIDATION_CATEGORIES, VALIDATION_SCOPES, VALIDATION_SKIP_POLICIES } from "./constants.ts";

export type CompletionLevel = typeof COMPLETION_LEVELS[number];
export type CompletionTarget = Exclude<CompletionLevel, "code_complete">;
export type CompletionLevels = Partial<Record<CompletionLevel, { required?: boolean } & Record<string, unknown>>>;
export type ValidationCategoryKind = typeof VALIDATION_CATEGORIES[number];
export type ValidationScope = typeof VALIDATION_SCOPES[number];
export type ValidationSkipPolicy = typeof VALIDATION_SKIP_POLICIES[number];
export type BehaviorAdapter = typeof BEHAVIOR_ADAPTERS[number];
export type FailureClass = typeof FAILURE_CLASSES[number];

export interface ValidationContractAssertion {
	id: string;
	description: string;
	priority?: "must" | "should" | "nice" | string;
	coveredBy?: string[];
	validationMethod?: "command" | "adversarial" | "both" | string;
}

export interface ValidationContract {
	assertions: ValidationContractAssertion[];
}

export interface MissionFeature {
	id: string;
	title: string;
	description?: string;
	assertions?: string[];
	localAssertions?: string[];
	localOnly?: boolean;
	repair?: boolean;
	repairSignature?: string;
}

export interface MissionMilestone {
	id: string;
	title: string;
	features: MissionFeature[];
}

export interface ValidationCategory {
	id: string;
	category: ValidationCategoryKind;
	title?: string;
	scope?: ValidationScope;
	adapter?: BehaviorAdapter;
	command?: string;
	commands?: string[];
	userTest?: boolean;
	adversarial?: boolean;
	modelRole?: "validator" | "domainCritic" | "opsCritic" | string;
	requiredFor?: CompletionLevel[];
	skipPolicy?: ValidationSkipPolicy;
	credentialGates?: string[];
	artifactsRequired?: string[];
	timeoutMs?: number | null;
	expectation?: string;
	successCriteria?: { mustMatch: string[]; mustNotMatch: string[] };
	generatedFrom?: string;
}

export interface ExternalServiceSpec {
	id: string;
	name?: string;
	purpose?: string;
	healthCommand?: string;
	smokeCommand?: string;
	credentialEnv?: string[];
	requiredFor?: CompletionLevel[];
	skipPolicy?: ValidationSkipPolicy;
	destructive?: boolean;
	liveExternalAction?: boolean;
}

export interface DeliverableValidationSpec {
	id?: string;
	name?: string;
	path?: string;
	command?: string;
	validationCommand?: string;
	category?: ValidationCategoryKind;
	requiredFor?: CompletionLevel[];
	skipPolicy?: ValidationSkipPolicy;
}

export interface DeliverablesSpec {
	entrypoints?: DeliverableValidationSpec[];
	runtimeArtifacts?: DeliverableValidationSpec[];
	runbooks?: DeliverableValidationSpec[];
}

export interface RoleConfig {
	model?: string;
	profile?: string;
	enabled?: boolean;
}

export interface RolePolicy {
	planner?: RoleConfig;
	worker?: RoleConfig;
	validator?: RoleConfig;
	domainCritic?: RoleConfig;
	opsCritic?: RoleConfig;
}

export interface CapabilityPolicy {
	network?: string;
	secrets?: string;
	destructiveGit?: boolean;
	deployment?: boolean;
	liveExternalActions?: boolean;
	maxCommandTimeoutMs?: number;
	featureReviewValidators?: boolean;
	userTestingValidator?: boolean;
	strategicRepairPlanner?: boolean;
}

export interface PromptPolicy {
	plannerPromptVersion?: string;
	workerPromptVersion?: string;
	validatorPromptVersion?: string;
	featureReviewPromptVersion?: string;
	userTestingValidatorPromptVersion?: string;
	repairPlannerPromptVersion?: string;
	handoffSchema?: string;
	validationReportSchema?: string;
}

export interface MissionPlan {
	schema?: string;
	missionId: string;
	goal: string;
	sourceDocs?: string[];
	workerProcedures?: string;
	cwd: string;
	baseRef?: string;
	worktreeBaseDir?: string;
	planner?: "pi" | "mock";
	completionTarget?: CompletionTarget;
	completionLevels?: CompletionLevels;
	maxRepairIterations?: number;
	modelPlan?: string;
	modelWorker?: string;
	modelValidator?: string;
	validationCommands?: string[];
	userTestCommand?: string;
	validationCategories?: ValidationCategory[];
	externalServices?: ExternalServiceSpec[];
	deliverables?: DeliverablesSpec;
	rolePolicy?: RolePolicy;
	capabilityPolicy?: CapabilityPolicy;
	promptPolicy?: PromptPolicy;
	milestones: MissionMilestone[];
	validationContract: ValidationContract;
}
