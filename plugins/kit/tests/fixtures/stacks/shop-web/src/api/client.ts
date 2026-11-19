import type { Order } from "../types/order";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json() as Promise<T>;
}

export const listOrders = () => request<Order[]>("/orders");
export const checkout = (cartId: string) => request<Order>(`/carts/${cartId}/checkout`, { method: "POST" });
