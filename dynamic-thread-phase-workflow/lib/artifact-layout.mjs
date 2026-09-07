// Fixed entries owned by the workflow runner inside each run's artifact directory.
// Keep persistence and user-artifact allocation on this shared inventory so a new
// internal file cannot silently become an available user-artifact name.
export const WORKFLOW_ARTIFACT_LAYOUT = Object.freeze({
  spec: "workflow-spec.json",
  checkpoint: "workflow-checkpoint.json",
  result: "workflow-result.json",
  processJournal: "workflow-processes.json",
  harnessManifest: "workflow-harness-manifest.json",
  harnessSource: "workflow-harness.mjs",
  phaseOutputsDirectory: "phase-outputs",
});

export const RUNNER_OWNED_ARTIFACT_NAMES = Object.freeze(Object.values(WORKFLOW_ARTIFACT_LAYOUT));

const RUNNER_OWNED_ARTIFACT_NAME_SET = new Set(RUNNER_OWNED_ARTIFACT_NAMES);
const ATOMIC_ROOT_TARGET_NAMES = Object.freeze([
  WORKFLOW_ARTIFACT_LAYOUT.checkpoint,
  WORKFLOW_ARTIFACT_LAYOUT.result,
  WORKFLOW_ARTIFACT_LAYOUT.processJournal,
]);

/** Return the sibling temporary path used for an atomic persistence target. */
export function atomicArtifactTemporaryPath(targetPath, token) {
  return `${targetPath}.${token}.tmp`;
}

/**
 * User emitters may not claim fixed runner entries or the temporary namespace
 * beside an atomically persisted root entry. Atomic phase-output temporaries are
 * contained beneath the separately reserved phaseOutputsDirectory.
 */
export function isRunnerOwnedArtifactName(fileName) {
  const name = String(fileName);
  if (RUNNER_OWNED_ARTIFACT_NAME_SET.has(name)) return true;
  return ATOMIC_ROOT_TARGET_NAMES.some((target) => name.startsWith(`${target}.`) && name.endsWith(".tmp"));
}
