import { z } from 'zod';

import { leafFn } from './leaf.ts';

export const schema = z.object({ value: z.string() });

export function describe(): string {
  return leafFn();
}
