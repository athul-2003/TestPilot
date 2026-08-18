import { Mastra } from '@mastra/core/mastra';

import { smokeAgent } from './agents/smoke-agent.ts';

/**
 * The Mastra instance — the single registry every part of Testpilot is
 * attached to.
 *
 * Registering things here rather than importing them directly is what lets the
 * rest of the codebase reach them via `mastra.getAgentById()` and
 * `mastra.getWorkflow()`. Those lookups carry shared services (storage, logging,
 * telemetry) with them, which a bare import does not.
 *
 * The key an agent is registered under is the name Studio shows and the name
 * `getAgentById()` expects — so it is part of the public surface, not an
 * internal detail.
 */
export const mastra = new Mastra({
  agents: {
    smokeAgent,
  },
});
