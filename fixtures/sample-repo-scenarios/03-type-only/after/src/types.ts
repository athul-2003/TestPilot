export interface Order {
  price: number;
  discountFraction: number;
  note?: string;
}

export interface PricingResult {
  total: number;
}
