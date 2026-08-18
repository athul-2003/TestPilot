import { Agent } from '@mastra/core/agent';

import { MODEL } from '../config.ts';

/**
 * A throwaway agent whose only job is to prove the wiring works.
 *
 * An **agent** in Mastra is a model plus a set of instructions, and optionally
 * some tools it may call. `instructions` is the system prompt — the standing
 * brief the model reads before every message.
 *
 * This one exists to satisfy Phase 0's exit gate: Studio starts, the agent
 * answers, and that single reply proves the API key is valid, the model string
 * resolves, and the Mastra server can reach OpenAI. Phase 1 replaces it with
 * the first real piece of Testpilot.
 *
 * Note the `.ts` extension on the import above — Node runs this TypeScript
 * directly, so local imports keep their real file extension.
 */
export const smokeAgent = new Agent({
  id: 'smoke-agent',
  name: 'Smoke Agent',
  description:
    'Temporary Phase 0 agent that confirms the Mastra server, model router, and provider API key are all working.',
  instructions: `You are a setup check for Testpilot, an AI CI test-triage tool.

Answer in one or two short sentences, confirming you can be reached.

Never state which model you are. Models do not reliably know their own
identity and will confidently name the wrong one — check the "provider" and
"modelId" fields from \`mastra api agent list\` instead, which report what is
actually wired up.

Do not invent details about Testpilot's features — the real agents that
select tests do not exist yet.`,
  model: MODEL,
});
