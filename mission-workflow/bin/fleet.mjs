/**
 * Optional per-agent endpoint routing via @autonome-research/fleet-router.
 *
 * Activated by the PI_FLEET env var: a JSON array of endpoint specs —
 *
 *   PI_FLEET='[
 *     { "url": "http://localhost:8033/v1", "maxContext": 262144,
 *       "capacity": 16, "outputReserve": 32768,
 *       "model": "vllm-qwen35-gpu0/qwen35a3b" },
 *     { "url": "http://localhost:8034/v1", "maxContext": 262144,
 *       "capacity": 16, "outputReserve": 32768,
 *       "model": "vllm-qwen35-gpu1/qwen35a3b" }
 *   ]'
 *
 * When set, each pi agent spawn leases an endpoint — sticky per agent label
 * (rendezvous affinityKey → stable GPU pinning for prefix-cache reuse) — and
 * runs with that endpoint's `model` ("provider/id", passed to pi as --model).
 * Process outcomes feed the router's circuit breaker, so a crashed or
 * restarting instance is routed around instead of failing successive agents.
 *
 * When PI_FLEET is unset (or invalid, or the router package is missing),
 * behavior is exactly as before: no routing, caller-provided --model.
 */

let routerPromise;
let warned = false;

function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.error(`[fleet] routing disabled: ${message}`);
}

async function getRouter() {
  const raw = process.env.PI_FLEET;
  if (!raw) return null;
  if (!routerPromise) {
    routerPromise = (async () => {
      const { FleetRouter } = await import("@autonome-research/fleet-router");
      const entries = JSON.parse(raw);
      const specs = entries.map((e) => ({
        url: e.url,
        maxContext: e.maxContext,
        capacity: e.capacity ?? 4,
        outputReserve: e.outputReserve,
        overheadTokens: e.overheadTokens,
        tags: e.tags,
        hardCap: e.hardCap,
        meta: { model: e.model },
      }));
      return new FleetRouter(specs);
    })().catch((error) => {
      warnOnce(error && error.message ? error.message : String(error));
      return null;
    });
  }
  return routerPromise;
}

/**
 * Lease an endpoint for one agent run, or null when routing is inactive.
 * Returns { model, url, release(ok) }; `model` is the "provider/id" string
 * to pass as pi's --model. release() is idempotent.
 */
export async function acquireFleetLease(affinityKey, promptChars = 0) {
  const router = await getRouter();
  if (!router) return null;
  try {
    const lease = await router.acquire({ promptChars, affinityKey });
    return {
      model: lease.endpoint.meta && lease.endpoint.meta.model,
      url: lease.endpoint.url,
      release: (ok) => lease.release({ ok: Boolean(ok) }),
    };
  } catch (error) {
    // A request no endpoint fits, or saturation with wait disabled — run
    // unrouted rather than blocking the mission.
    warnOnce(error && error.message ? error.message : String(error));
    return null;
  }
}
