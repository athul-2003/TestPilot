import { multiply } from './math.ts';

/** Applies a fractional discount (0.1 = 10% off) to a price. */
export function applyDiscount(price: number, fraction: number): number {
  return price - multiply(price, fraction);
}
