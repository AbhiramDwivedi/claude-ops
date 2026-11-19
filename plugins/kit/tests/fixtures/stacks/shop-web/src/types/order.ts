export type OrderStatus = "cart" | "paid" | "shipped" | "returned";

export interface OrderLine {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  lines: OrderLine[];
  shipmentTracking?: string;
}
