const B = "http://localhost:4000";
const H = (role, actor, extra = {}) => ({
  "Content-Type": "application/json", "X-Role": role, "X-Actor": actor, ...extra,
});
const post = async (p, body, h) => {
  const r = await fetch(B + p, { method: "POST", headers: h, body: body ? JSON.stringify(body) : undefined });
  return [r.status, await r.json()];
};

const out = [];
const log = (...a) => { out.push(a.join(" ")); };

await post("/api/test/reset", {}, H("agent", "x"));
let s, j;
[s, j] = await post("/api/returns", { orderId: 1, items: [{ orderItemId: 1, qty: 2 }, { orderItemId: 2, qty: 2 }] }, H("agent", "A001", { "Idempotency-Key": "k1" }));
log("create", s, j.ok, j.data?.return_no, j.error?.code || "");
const id = j.data.id;

[s, j] = await post("/api/returns", { orderId: 1, items: [{ orderItemId: 1, qty: 2 }] }, H("agent", "A001", { "Idempotency-Key": "k1" }));
log("replay same key -> id equal:", j.data.id === id);

[s, j] = await post("/api/returns", { orderId: 1, items: [{ orderItemId: 1, qty: 1 }] }, H("agent", "A001", { "Idempotency-Key": "k2" }));
log("in-transit dup ->", s, j.error.code);

[s, j] = await post("/api/returns", { orderId: 1, items: [{ orderItemId: 2, qty: 1 }] }, H("warehouse", "W001", { "Idempotency-Key": "k3" }));
log("warehouse create forbidden ->", s, j.error.code);

[s, j] = await post(`/api/returns/${id}/inspect`, { allocations: [] }, H("warehouse", "W001"));
log("inspect before sign (skip step) ->", s, j.error.code);

[s, j] = await post(`/api/returns/${id}/sign`, {}, H("agent", "A001"));
log("agent sign forbidden ->", s, j.error.code);

[s, j] = await post(`/api/returns/${id}/sign`, {}, H("warehouse", "W001"));
log("sign ->", s, j.data.status);

for (const c of ["KB-1", "KB-2", "KB-1"])
  await post(`/api/returns/${id}/scan`, { productId: 1, scanCode: c }, H("warehouse", "W001"));
for (const c of ["MS-1", "MS-2"])
  await post(`/api/returns/${id}/scan`, { productId: 2, scanCode: c }, H("warehouse", "W001"));
[s, j] = await post(`/api/returns/${id}/scan`, { productId: 1, scanCode: "KB-1" }, H("warehouse", "W001"));
log("dup scan flag=", j.data.duplicate, "kb received=", j.data.items.find((i) => i.product_id === 1).received_qty);

[s, j] = await post(`/api/returns/${id}/inspect`, { allocations: [{ productId: 1, restockQty: 1, repairQty: 0, scrapQty: 0 }, { productId: 2, restockQty: 2, repairQty: 0, scrapQty: 0 }] }, H("warehouse", "W001"));
log("bad allocation ->", s, j.error.code);

[s, j] = await post(`/api/returns/${id}/inspect`, { allocations: [{ productId: 1, restockQty: 2, repairQty: 0, scrapQty: 0 }, { productId: 2, restockQty: 1, repairQty: 1, scrapQty: 0 }] }, H("warehouse", "W001"));
log("inspect ->", s, j.data.status);

[s, j] = await post(`/api/returns/${id}/dispose`, {}, H("warehouse", "W001"));
const expected = 2 * 39900 + 12900 + Math.round(12900 * 0.3);
log("dispose ->", s, j.data.status, "refund=", j.data.refund_total_cents, "expected=", expected, "match=", j.data.refund_total_cents === expected, "needsSup=", j.data.needs_supervisor);

[s, j] = await post(`/api/returns/${id}/close`, {}, H("warehouse", "W001"));
log("warehouse close forbidden ->", s, j.error.code);
[s, j] = await post(`/api/returns/${id}/close`, {}, H("supervisor", "S001"));
log("close ->", s, j.data?.status);

[s, j] = await post("/api/returns", { orderId: 1, items: [{ orderItemId: 1, qty: 1 }] }, H("agent", "A001", { "Idempotency-Key": "k4" }));
log("over purchased after close ->", s, j.error.code);

// 高金额复核流程（显示器 1899 返库 -> >=1000 需复核）
[s, j] = await post("/api/returns", { orderId: 2, items: [{ orderItemId: 3, qty: 1 }] }, H("agent", "A001", { "Idempotency-Key": "k5" }));
const id2 = j.data.id;
log("create monitor return", s, j.data?.return_no);
await post(`/api/returns/${id2}/sign`, {}, H("warehouse", "W001"));
await post(`/api/returns/${id2}/scan`, { productId: 3, scanCode: "MN-1" }, H("warehouse", "W001"));
await post(`/api/returns/${id2}/inspect`, { allocations: [{ productId: 3, restockQty: 1, repairQty: 0, scrapQty: 0 }] }, H("warehouse", "W001"));
[s, j] = await post(`/api/returns/${id2}/dispose`, {}, H("warehouse", "W001"));
log("monitor dispose needsSup=", j.data.needs_supervisor, "refund=", j.data.refund_total_cents);
[s, j] = await post(`/api/returns/${id2}/close`, {}, H("supervisor", "S001"));
log("close before review ->", s, j.error.code);
[s, j] = await post(`/api/returns/${id2}/review`, { decision: "approved" }, H("agent", "A001"));
log("agent review forbidden ->", s, j.error.code);
[s, j] = await post(`/api/returns/${id2}/review`, { decision: "approved" }, H("supervisor", "S001"));
log("review ->", s, j.data.refund.status);
[s, j] = await post(`/api/returns/${id2}/close`, {}, H("supervisor", "S001"));
log("close after review ->", s, j.data?.status);

console.log(out.join("\n"));
