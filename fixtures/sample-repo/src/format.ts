/** Formats a number as a US-dollar string, e.g. 9.5 -> "$9.50". */
export function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
