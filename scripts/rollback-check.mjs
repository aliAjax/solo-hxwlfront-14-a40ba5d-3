const B = "http://localhost:4000";
const H = (role, actor, extra = {}) => ({ "Content-Type": "application/json", "X-Role": role, "X-Actor": actor, ...extra });
const req = async (method, p, body, h) => {
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return [r.status, await r.json()];
};
const post = (p, body, h) => req("POST", p, body, h);
const get = async (p) => (await fetch(B + p)).json();

await post("/api/test/reset", {}, H("agent", "x"));
const before = await get("/api/returns");

// ---- 回滚场景1：建单中途失败 ----
await post("/api/test/fault", { failNextCreate: true }, H("agent", "x"));
const [cs, cj] = await post("/api/returns", { orderId: 1, items: [{ orderItemId: 1, qty: 1 }] }, H("agent", "A001", { "Idempotency-Key": "rollback-1" }));
const afterCreate = await get("/api/returns");
const audits1 = (await get("/api/audits")).data.filter((a) => a.action === "create" && a.result === "success");
console.log("faulted create status:", cs, cj.error.code);
console.log("returns count unchanged:", before.data.length === afterCreate.data.length, `(${before.data.length}->${afterCreate.data.length})`);
console.log("no success create audit:", audits1.length === 0);

// 失败后同键重试应成功（幂等键未被失败占用）
const [rs, rj] = await post("/api/returns", { orderId: 1, items: [{ orderItemId: 1, qty: 1 }] }, H("agent", "A001", { "Idempotency-Key": "rollback-1" }));
console.log("retry after rollback:", rs, rj.ok, rj.data?.return_no);
const id = rj.data.id;

// ---- 回滚场景2：处置中途失败 ----
await post(`/api/returns/${id}/sign`, {}, H("warehouse", "W001"));
await post(`/api/returns/${id}/scan`, { productId: 1, scanCode: "X1" }, H("warehouse", "W001"));
await post(`/api/returns/${id}/inspect`, { allocations: [{ productId: 1, restockQty: 1, repairQty: 0, scrapQty: 0 }] }, H("warehouse", "W001"));

await post("/api/test/fault", { failNextDispose: true }, H("agent", "x"));
const [ds, dj] = await post(`/api/returns/${id}/dispose`, {}, H("warehouse", "W001"));
const detail = (await get(`/api/returns/${id}`)).data;
const disposeAudits = (await get("/api/audits")).data.filter((a) => a.action === "dispose");
console.log("faulted dispose status:", ds, dj.error.code);
console.log("status still inspected:", detail.status === "inspected", `(${detail.status})`);
console.log("no dispositions rows:", detail.dispositions.length === 0);
console.log("no refund record:", detail.refund === null);
console.log("refund_total still 0:", detail.refund_total_cents === 0);
console.log("item refund_cents still 0:", detail.items[0].refund_cents === 0);
console.log("no dispose audit:", disposeAudits.length === 0);

// 重试处置成功，流程可继续
const [ds2, dj2] = await post(`/api/returns/${id}/dispose`, {}, H("warehouse", "W001"));
console.log("retry dispose:", ds2, dj2.data.status, "refund=", dj2.data.refund_total_cents);
const [cls, clj] = await post(`/api/returns/${id}/close`, {}, H("supervisor", "S001"));
console.log("close:", cls, clj.data?.status);
