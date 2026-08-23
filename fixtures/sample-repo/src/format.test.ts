import { describe, expect, it } from 'vitest';

import { formatCurrency } from './format.ts';

describe('formatCurrency', () => {
  it('formats a positive amount to two decimal places', () => {
    expect(formatCurrency(9.5)).toBe('$9.50');
  });

  it('formats a negative amount with the sign before the dollar-sign', () => {
    expect(formatCurrency(-3)).toBe('$-3.00');
  });
});
