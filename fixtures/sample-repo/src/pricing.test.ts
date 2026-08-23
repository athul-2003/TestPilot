import { describe, expect, it } from 'vitest';

import { calculateTotal } from './pricing.ts';

describe('calculateTotal', () => {
  it('applies the discount to the order price', () => {
    expect(calculateTotal({ price: 100, discountFraction: 0.1 })).toEqual({ total: 90 });
  });

  it('returns the full price when there is no discount', () => {
    expect(calculateTotal({ price: 40, discountFraction: 0 })).toEqual({ total: 40 });
  });
});
