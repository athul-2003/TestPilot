import type { Order } from './types.ts';

export function isValidOrder(order: Order): boolean {
  return order.price >= 0 && order.discountFraction >= 0 && order.discountFraction <= 1;
}
