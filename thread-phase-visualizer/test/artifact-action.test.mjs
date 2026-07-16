import test from "node:test";
import assert from "node:assert/strict";

import { artifactEditorActionHint, artifactEditorTarget } from "../lib/artifact-action.mjs";

test("artifact editor action returns an unambiguous path or URL", () => {
  assert.equal(artifactEditorTarget({ kind: "file", path: "/repo/report.md" }), "/repo/report.md");
  assert.equal(artifactEditorTarget({ kind: "url", url: "https://example.test/report" }), "https://example.test/report");
  assert.equal(artifactEditorTarget({ path: " /repo/report.md " }), "/repo/report.md");
  assert.equal(artifactEditorActionHint({ path: "/repo/report.md" }), "c send target to editor");
});

test("inline, preview-only, and ambiguous artifacts have no editor action", () => {
  assert.equal(artifactEditorTarget({ kind: "markdown", content: "# Inline" }), undefined);
  assert.equal(artifactEditorTarget({ kind: "json", preview: "preview" }), undefined);
  assert.equal(artifactEditorTarget({ path: "/repo/report.md", url: "https://example.test/report" }), undefined);
  assert.equal(artifactEditorActionHint({ content: "inline" }), "no actionable target (inline/preview only)");
});
