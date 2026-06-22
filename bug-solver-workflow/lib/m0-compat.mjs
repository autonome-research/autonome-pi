// Compatibility helpers for the committed M0 bug-solver scaffold.
//
// These helpers are intentionally pure/read-only so later milestones can reuse
// the same pre-implementation safety checks without changing the public
// precheck/solve/status surface or mutating target repositories.

export const BUG_SOLVER_WORKFLOW_NAME = "bug-solver-workflow";

export const BUG_SOLVER_SCHEMAS = Object.freeze({
  precheck: "pi-bug-solver-workflow/precheck/v1",
  transactionPlan: "pi-bug-solver-workflow/transaction-plan/v1",
  validationContract: "pi-bug-solver-workflow/validation-contract/v1",
  state: "pi-bug-solver-workflow/state/v1",
  activationScaffold: "pi-bug-solver-workflow/activation-scaffold/v1",
});

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boolOr(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function isBugSolverPrecheckArtifact(value) {
  return asObject(value).schema === BUG_SOLVER_SCHEMAS.precheck;
}

export function isBugSolverTransactionPlan(value) {
  return asObject(value).schema === BUG_SOLVER_SCHEMAS.transactionPlan;
}

export function normalizeSolvePlanArtifact(artifact) {
  const input = asObject(artifact);
  const transaction = asObject(input.transaction);
  const validation = asObject(input.validation);
  const evidencePaths = asObject(input.evidencePaths);

  return {
    schema: input.schema,
    transactionId: input.transactionId,
    status: input.status,
    editingAllowed: boolOr(input.editingAllowed, false),
    transaction: {
      exactlyOneBug: boolOr(transaction.exactlyOneBug, input.multiplicity?.likelyMultiple === undefined ? undefined : !input.multiplicity.likelyMultiple),
      bugDescription: firstString(transaction.bugDescription, input.bugDescription, input.bug),
      multiplicity: asObject(transaction.multiplicity).likelyMultiple !== undefined ? transaction.multiplicity : asObject(input.multiplicity),
      splitRequired: boolOr(transaction.splitRequired, boolOr(input.multiplicity?.likelyMultiple, false)),
    },
    validationContractPath: firstString(input.validationContractPath, validation.contractPath),
    evidencePaths,
    artifacts: asObject(input.artifacts),
    sourceKind: isBugSolverPrecheckArtifact(input) ? "precheck" : isBugSolverTransactionPlan(input) ? "transaction-plan" : "legacy-compatible-plan",
  };
}

export function assessPreImplementationGate(artifact, multiplicityOverride) {
  const plan = normalizeSolvePlanArtifact(artifact);
  const effectiveMultiplicity = asObject(multiplicityOverride).likelyMultiple !== undefined
    ? asObject(multiplicityOverride)
    : asObject(plan.transaction.multiplicity);
  const exactlyOneBug = effectiveMultiplicity.likelyMultiple
    ? false
    : boolOr(plan.transaction.exactlyOneBug, !effectiveMultiplicity.likelyMultiple);
  const reasons = [];

  if (!plan.transactionId) reasons.push("missing transactionId");
  if (plan.status === "rejected_multi_bug" || effectiveMultiplicity.likelyMultiple || exactlyOneBug === false || plan.transaction.splitRequired) reasons.push("multi-bug or split-required transaction");
  if (plan.editingAllowed === true) reasons.push("plan was not preserved as pre-implementation/editingAllowed=false");
  if (!plan.validationContractPath) reasons.push("missing durable validation contract path");

  return {
    transactionId: plan.transactionId,
    sourceKind: plan.sourceKind,
    status: plan.status,
    editingAllowed: plan.editingAllowed,
    exactlyOneBug,
    splitRequired: Boolean(plan.transaction.splitRequired || effectiveMultiplicity.likelyMultiple),
    validationContractPath: plan.validationContractPath,
    safeBeforeEditCapablePhase: reasons.length === 0,
    reasons,
  };
}
