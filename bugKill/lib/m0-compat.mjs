// Compatibility helpers for the committed M0 bugKill scaffold.
//
// These helpers are intentionally pure/read-only so later milestones can reuse
// the same pre-implementation safety checks without changing the public
// precheck/solve/status surface or mutating target repositories.

export const BUGKILL_WORKFLOW_NAME = "bugKill";

export const BUGKILL_SCHEMAS = Object.freeze({
  precheck: "pi-bugKill/precheck/v1",
  transactionPlan: "pi-bugKill/transaction-plan/v1",
  validationContract: "pi-bugKill/validation-contract/v1",
  state: "pi-bugKill/state/v1",
  gatedActivation: "pi-bugKill/gated-activation/v1",
});

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boolOr(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function isExplicitBoolean(value) {
  return typeof value === "boolean";
}

function explicitFalse(value) {
  return value === false;
}

function explicitTrue(value) {
  return value === true;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function dirtyStatus(repo) {
  const value = asObject(repo);
  const dirty = asObject(value.dirtyAtPrecheck || value.dirty);
  const statusShort = firstString(value.statusAtPrecheck, value.statusShort, dirty.statusShort) || "";
  return {
    hasDirtyWorktree: dirty.hasDirtyWorktree === true || Boolean(statusShort.trim()),
    statusShort,
  };
}

export function isBugKillPrecheckArtifact(value) {
  return asObject(value).schema === BUGKILL_SCHEMAS.precheck;
}

export function isBugKillTransactionPlan(value) {
  return asObject(value).schema === BUGKILL_SCHEMAS.transactionPlan;
}

export function normalizeSolvePlanArtifact(artifact) {
  const input = asObject(artifact);
  const transaction = asObject(input.transaction);
  const validation = asObject(input.validation);
  const evidencePaths = asObject(input.evidencePaths);
  const transactionMultiplicity = asObject(transaction.multiplicity);
  const topLevelMultiplicity = asObject(input.multiplicity);
  const multiplicity = isExplicitBoolean(transactionMultiplicity.likelyMultiple) ? transactionMultiplicity : topLevelMultiplicity;

  return {
    schema: input.schema,
    transactionId: input.transactionId,
    status: input.status,
    editingAllowed: boolOr(input.editingAllowed, false),
    hasExplicitEditingAllowed: isExplicitBoolean(input.editingAllowed),
    confirmationRequired: isExplicitBoolean(input.confirmationRequired) ? input.confirmationRequired : undefined,
    readOnly: isExplicitBoolean(input.readOnly) ? input.readOnly : undefined,
    transaction: {
      // Do not infer exactly-one-bug safety from missing fields. The solve gate
      // must see explicit precheck/plan evidence before any edit-capable phase.
      exactlyOneBug: isExplicitBoolean(transaction.exactlyOneBug) ? transaction.exactlyOneBug : undefined,
      bugDescription: firstString(transaction.bugDescription, input.bugDescription, input.bug),
      multiplicity,
      splitRequired: isExplicitBoolean(transaction.splitRequired) ? transaction.splitRequired : (isExplicitBoolean(multiplicity.likelyMultiple) ? multiplicity.likelyMultiple : undefined),
    },
    validationContractPath: firstString(input.validationContractPath, validation.contractPath),
    evidencePaths,
    artifacts: asObject(input.artifacts),
    repo: asObject(input.repo || input.immutableTransactionIdentity?.repo || input.git),
    sourceKind: isBugKillPrecheckArtifact(input) ? "precheck" : isBugKillTransactionPlan(input) ? "transaction-plan" : "unrecognized-schema",
  };
}

export function assessPreImplementationGate(artifact, multiplicityOverride) {
  const plan = normalizeSolvePlanArtifact(artifact);
  const overrideMultiplicity = asObject(multiplicityOverride);
  const artifactMultiplicity = asObject(plan.transaction.multiplicity);
  const effectiveMultiplicity = isExplicitBoolean(overrideMultiplicity.likelyMultiple) ? overrideMultiplicity : artifactMultiplicity;
  const hasExplicitMultiplicity = isExplicitBoolean(artifactMultiplicity.likelyMultiple);
  const hasExplicitExactlyOneBug = isExplicitBoolean(plan.transaction.exactlyOneBug);
  const recognizedSchema = plan.sourceKind === "precheck" || plan.sourceKind === "transaction-plan";
  const hasExplicitOneBugSafetyEvidence = plan.sourceKind === "transaction-plan"
    ? hasExplicitExactlyOneBug && plan.transaction.exactlyOneBug === true && hasExplicitMultiplicity && artifactMultiplicity.likelyMultiple === false
    : plan.sourceKind === "precheck" && hasExplicitMultiplicity && artifactMultiplicity.likelyMultiple === false;
  const exactlyOneBug = effectiveMultiplicity.likelyMultiple === true ? false : (hasExplicitExactlyOneBug ? plan.transaction.exactlyOneBug : (hasExplicitOneBugSafetyEvidence ? true : undefined));
  const splitRequired = plan.transaction.splitRequired === true || effectiveMultiplicity.likelyMultiple === true;
  const reasons = [];

  if (!recognizedSchema) reasons.push("unrecognized bugKill plan schema");
  if (!hasExplicitOneBugSafetyEvidence) reasons.push("missing explicit one-bug safety evidence");
  if (!plan.transactionId) reasons.push("missing transactionId");
  if (plan.status === "rejected_multi_bug" || splitRequired || exactlyOneBug === false) reasons.push("multi-bug or split-required transaction");
  if (!plan.hasExplicitEditingAllowed || !explicitFalse(plan.editingAllowed)) reasons.push("missing explicit pre-implementation editing lock (editingAllowed=false)");
  if (!explicitTrue(plan.confirmationRequired)) reasons.push("missing explicit confirmationRequired=true approval marker");
  if (plan.sourceKind === "precheck" && !explicitTrue(plan.readOnly)) reasons.push("missing explicit readOnly=true precheck marker");
  if (!plan.validationContractPath) reasons.push("missing durable validation contract path");
  if (dirtyStatus(plan.repo).hasDirtyWorktree) reasons.push("precheck recorded dirty worktree signals");

  return {
    transactionId: plan.transactionId,
    sourceKind: plan.sourceKind,
    status: plan.status,
    editingAllowed: plan.editingAllowed,
    exactlyOneBug,
    splitRequired: Boolean(splitRequired),
    validationContractPath: plan.validationContractPath,
    safeBeforeEditCapablePhase: reasons.length === 0,
    reasons,
  };
}
