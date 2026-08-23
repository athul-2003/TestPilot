import { applyDiscount } from './discount.ts';
import type { Order, PricingResult } from './types.ts';

export function calculateTotal(order: Order): PricingResult {
  return { total: applyDiscount(order.price, order.discountFraction) };
}
