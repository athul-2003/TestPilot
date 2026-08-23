import { describe, expect, it } from 'vitest';

import { isValidOrder } from './validate.ts';

describe('isValidOrder', () => {
  it('accepts a well-formed order', () => {
    expect(isValidOrder({ price: 10, discountFraction: 0.5 })).toBe(true);
  });

  it('rejects a discount fraction above 1', () => {
    expect(isValidOrder({ price: 10, discountFraction: 1.5 })).toBe(false);
  });
});
