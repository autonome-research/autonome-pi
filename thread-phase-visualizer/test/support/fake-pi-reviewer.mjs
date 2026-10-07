#!/usr/bin/env node
// FIXTURE ONLY: deterministic offline stand-in for the `pi` reviewer/explorer
// subprocess. Emits one JSON assistant message and exits 0.
// PI_FAKE_PI_FAIL=1 exits 1 instead; PI_FAKE_PI_SLEEP_MS delays the answer so
// cancellation can be exercised. No network, no provider, no credentials.
const sleepMs = Number(process.env.PI_FAKE_PI_SLEEP_MS || 0);
setTimeout(() => {
	if (process.env.PI_FAKE_PI_FAIL) {
		console.error("fixture reviewer failure");
		process.exit(1);
	}
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "# Review\n\n## Verdict\n✅ low risk\n\n## Critical findings\n\nNone found.\n" }],
		model: "fixture-local",
		stopReason: "stop",
	};
	process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
}, sleepMs);
