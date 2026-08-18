import type { z } from 'zod';

/**
 * The minimum shape an agent-calling function needs from "an agent" —
 * narrower than Mastra's real `Agent` class so a test can inject a stub that
 * never touches the network, without constructing a real `Agent` to satisfy
 * it. Generic over the output schema so every agent in this codebase shares
 * one definition instead of each redeclaring the identical shape with only
 * the schema type varying.
 */
export interface StructuredGenerator<TSchema extends z.ZodTypeAny> {
  generate(
    prompt: string,
    options: { structuredOutput: { schema: TSchema } },
  ): Promise<{
    object: z.infer<TSchema>;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  }>;
}
