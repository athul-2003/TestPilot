import { describe, expect, it } from 'vitest';

import { applyDiscount } from './discount.ts';

describe('applyDiscount', () => {
  it('reduces the price by the given fraction', () => {
    expect(applyDiscount(100, 0.2)).toBe(80);
  });

  it('leaves the price unchanged at zero discount', () => {
    expect(applyDiscount(50, 0)).toBe(50);
  });
});
