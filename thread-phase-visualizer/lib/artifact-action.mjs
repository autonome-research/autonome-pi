function nonEmptyTarget(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Return the sole external artifact target that is safe to place in Pi's editor.
 * Preview and inline content are deliberately not actionable, and artifacts that
 * specify different path and URL targets are treated as ambiguous.
 */
export function artifactEditorTarget(artifact) {
  if (!artifact || typeof artifact !== "object") return undefined;
  const targets = [...new Set([
    nonEmptyTarget(artifact.path),
    nonEmptyTarget(artifact.url),
  ].filter(Boolean))];
  return targets.length === 1 ? targets[0] : undefined;
}

export function artifactEditorActionHint(artifact) {
  return artifactEditorTarget(artifact)
    ? "c send target to editor"
    : "no actionable target (inline/preview only)";
}
