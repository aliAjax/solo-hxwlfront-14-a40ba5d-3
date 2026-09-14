// 后端 API 封装。身份通过请求头 X-Actor / X-Role 传递（演示用，模拟登录态）。
export type Role = "agent" | "warehouse" | "supervisor";

export interface Identity {
  actor: string;
  role: Role;
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  price_cents: number;
}

export interface OrderItem {
  id: number;
  order_id: number;
  product_id: number;
  qty: number;
  unit_price_cents: number;
  sku: string;
  name: string;
  in_transit_qty: number;
  returned_qty: number;
}

export interface Order {
  id: number;
  order_no: string;
  customer: string;
  created_at: string;
  items: OrderItem[];
}

export type ReturnStatus =
  | "booked"
  | "signed"
  | "inspected"
  | "disposed"
  | "closed";

export interface ReturnItem {
  id: number;
  product_id: number;
  order_item_id: number;
  qty: number;
  received_qty: number;
  restock_qty: number;
  repair_qty: number;
  scrap_qty: number;
  refund_cents: number;
  sku: string;
  name: string;
  unit_price_cents: number;
  purchased_qty: number;
}

export interface Refund {
  total_cents: number;
  status: "computed" | "approved" | "rejected";
  reviewed_by: string | null;
}

export interface ReturnOrder {
  id: number;
  return_no: string;
  order_id: number;
  status: ReturnStatus;
  created_by: string;
  current_step_by: string | null;
  refund_total_cents: number;
  needs_supervisor: number;
  approved_by: string | null;
  order: { order_no: string; customer: string };
  items: ReturnItem[];
  scans: { id: number; product_id: number; scan_code: string; scanned_by: string }[];
  dispositions: unknown[];
  refund: Refund | null;
}

export interface AuditRow {
  id: number;
  return_order_id: number | null;
  actor: string;
  action: string;
  detail: string;
  result: "success" | "denied" | "failed";
  created_at: string;
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let identity: Identity = { actor: "A001", role: "agent" };
export function setIdentity(i: Identity) {
  identity = i;
}
export function getIdentity() {
  return identity;
}

async function call<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Actor": identity.actor,
      "X-Role": identity.role,
      ...(options.headers || {}),
    },
  });
  const json = await res.json();
  if (!json.ok) throw new ApiError(res.status, json.error.code, json.error.message);
  return json.data as T;
}

// 生成幂等键
export function idemKey() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const api = {
  orders: () => call<Order[]>("/api/orders"),
  returns: () => call<{ id: number; return_no: string; status: ReturnStatus; order_id: number }[]>("/api/returns"),
  returnDetail: (id: number) => call<ReturnOrder>(`/api/returns/${id}`),
  audits: () => call<AuditRow[]>("/api/audits"),
  config: () => call<{ refundReviewThresholdCents: number }>("/api/config"),

  createReturn: (
    orderId: number,
    items: { orderItemId: number; qty: number }[],
    key: string
  ) =>
    call<ReturnOrder>("/api/returns", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ orderId, items, idempotencyKey: key }),
    }),

  sign: (id: number) => call<ReturnOrder>(`/api/returns/${id}/sign`, { method: "POST" }),
  scan: (id: number, productId: number, scanCode: string) =>
    call<ReturnOrder & { duplicate?: boolean }>(`/api/returns/${id}/scan`, {
      method: "POST",
      body: JSON.stringify({ productId, scanCode }),
    }),
  inspect: (
    id: number,
    allocations: { productId: number; restockQty: number; repairQty: number; scrapQty: number }[]
  ) =>
    call<ReturnOrder>(`/api/returns/${id}/inspect`, {
      method: "POST",
      body: JSON.stringify({ allocations }),
    }),
  dispose: (id: number) => call<ReturnOrder>(`/api/returns/${id}/dispose`, { method: "POST" }),
  review: (id: number, decision: "approved" | "rejected") =>
    call<ReturnOrder>(`/api/returns/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    }),
  close: (id: number) => call<ReturnOrder>(`/api/returns/${id}/close`, { method: "POST" }),

  // 测试辅助
  fault: (body: { failNextCreate?: boolean; failNextDispose?: boolean }) =>
    call("/api/test/fault", { method: "POST", body: JSON.stringify(body) }),
  reset: () => call("/api/test/reset", { method: "POST" }),
};

export function yuan(cents: number) {
  return `¥${(cents / 100).toFixed(2)}`;
}
