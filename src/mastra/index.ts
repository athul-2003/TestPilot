import { Mastra } from '@mastra/core/mastra';

import { impactAgent } from './agents/impact-agent.ts';
import { smokeAgent } from './agents/smoke-agent.ts';
import { astParseTool } from './tools/ast-parse-tool.ts';
import { gitDiffTool } from './tools/git-diff-tool.ts';
import { importGraphTool } from './tools/import-graph-tool.ts';
import { testInventoryTool } from './tools/test-inventory-tool.ts';

/**
 * The Mastra instance — the single registry every part of Testpilot is
 * attached to.
 *
 * Registering things here rather than importing them directly is what lets the
 * rest of the codebase reach them via `mastra.getAgentById()` and
 * `mastra.getWorkflow()`. Those lookups carry shared services (storage, logging,
 * telemetry) with them, which a bare import does not.
 *
 * The key an agent or tool is registered under is the name Studio shows and
 * the name the API/CLI expects — so it is part of the public surface, not an
 * internal detail.
 */
export const mastra = new Mastra({
  agents: {
    smokeAgent,
    impactAgent,
  },
  tools: {
    gitDiffTool,
    astParseTool,
    importGraphTool,
    testInventoryTool,
  },
});
