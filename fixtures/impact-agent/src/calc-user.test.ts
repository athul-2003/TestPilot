import { describe, expect, it } from 'vitest';

import { use } from './calc-user.ts';

describe('use', () => {
  it('uses calc', () => {
    expect(use()).toBe(3);
  });
});
