import { describe, expect, it } from 'vitest';

import { calc } from './calc.ts';

describe('calc', () => {
  it('adds', () => {
    expect(calc(1, 2)).toBe(3);
  });
});
