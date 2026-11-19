import { useEffect, useState } from "react";
import { listOrders } from "../api/client";
import type { Order } from "../types/order";

export function OrderList() {
  const [orders, setOrders] = useState<Order[]>([]);
  useEffect(() => {
    listOrders().then(setOrders);
  }, []);
  return (
    <ul>
      {orders.map((o) => (
        <li key={o.id}>{o.id}: {o.status}</li>
      ))}
    </ul>
  );
}
