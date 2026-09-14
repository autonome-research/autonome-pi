import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKFLOW_ARTIFACT_LAYOUT, RUNNER_OWNED_ARTIFACT_NAMES, isRunnerOwnedArtifactName } from '../lib/artifact-layout.mjs';

test('delegation directory and descendants reserved even when feature is disabled', () => {
  assert.equal(WORKFLOW_ARTIFACT_LAYOUT.delegationDirectory, 'delegation');
  assert.ok(RUNNER_OWNED_ARTIFACT_NAMES.includes('delegation'));
  for (const path of ['delegation', 'delegation/', 'delegation/manifest.json', 'delegation/nodes/id.blob', 'delegation/state.json.uuid.tmp']) assert.equal(isRunnerOwnedArtifactName(path), true, path);
  for (const path of ['delegation.md', 'delegation-other', 'my-delegation']) assert.equal(isRunnerOwnedArtifactName(path), false, path);
  assert.equal(isRunnerOwnedArtifactName('workflow-result.json.token.tmp'), true);
});
