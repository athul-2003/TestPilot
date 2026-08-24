import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';

import { flakyAgent } from './agents/flaky-agent.ts';
import { impactAgent } from './agents/impact-agent.ts';
import { astParseTool } from './tools/ast-parse-tool.ts';
import { ciAnnotateTool } from './tools/ci-annotate-tool.ts';
import { gitDiffTool } from './tools/git-diff-tool.ts';
import { importGraphTool } from './tools/import-graph-tool.ts';
import { testHistoryTool } from './tools/test-history-tool.ts';
import { testInventoryTool } from './tools/test-inventory-tool.ts';
import { triageWorkflow } from './workflows/triage-workflow.ts';

/**
 * The Mastra instance — the single registry every part of Testpilot is
 * attached to.
 *
 * Registering things here rather than importing them directly is what lets the
 * rest of the codebase reach them via `mastra.getAgentById()` and
 * `mastra.getWorkflow()`. Those lookups carry shared services (storage, logging,
 * telemetry) with them, which a bare import does not.
 *
 * The key an agent, tool, or workflow is registered under is the name Studio
 * shows and the name the API/CLI expects — so it is part of the public
 * surface, not an internal detail.
 *
 * `storage` here is Testpilot's *own* operational store (Memory requires a
 * storage provider; `LibSQLStore` needs an `id`) — not where flaky-test
 * history lives. `LibSQLStore`'s domains (memory, workflows, scores, ...)
 * are a fixed schema for Mastra's own internal concerns with no generic
 * "store your own table" API, so `test-history-tool.ts` uses `@libsql/client`
 * directly, against its own per-repo database file. Both are the same
 * underlying technology; they solve two different, deliberately separate
 * problems.
 */
/**
 * The programmatic entry point, re-exported so `import { triageWorkflow }
 * from 'testpilot'` — which the README documents — actually resolves. A
 * consumer embedding Testpilot in their own tooling wants the workflow
 * directly, not the whole Mastra registry.
 */
export { triageWorkflow, type TriageResult } from './workflows/triage-workflow.ts';

export const mastra = new Mastra({
  agents: {
    impactAgent,
    flakyAgent,
  },
  tools: {
    gitDiffTool,
    astParseTool,
    importGraphTool,
    testInventoryTool,
    ciAnnotateTool,
    testHistoryTool,
  },
  workflows: {
    triageWorkflow,
  },
  storage: new LibSQLStore({ id: 'testpilot-storage', url: 'file:./testpilot-storage.db' }),
});
