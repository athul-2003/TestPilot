import { describe, expect, it } from 'vitest';

import { unrelated } from './unrelated.ts';

describe('unrelated', () => {
  it('is unrelated', () => {
    expect(unrelated()).toBe('unrelated');
  });
});
