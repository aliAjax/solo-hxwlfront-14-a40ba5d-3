import { test as base, expect, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// 与 helpers 一致：每个用例前重置默认（测试环境）服务
const test = base.extend({
  page: async ({ page }, use) => {
    await page.request.post("/api/test/reset");
    await page.goto("/");
    await use(page);
  },
});

async function api(page: Page, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const res = await page.request.fetch(path, { method, headers, data: body as any });
  const json = await res.json().catch(() => ({}));
  return { status: res.status(), json };
}

const H = (role: string, actor: string, extra: Record<string, string> = {}) => ({
  "Content-Type": "application/json", "X-Role": role, "X-Actor": actor, ...extra,
});

// 键盘走到「已质检」：申请 2，扫 2，全返库分摊
async function keyboardToInspected(page: Page, idem: string, qty: 2 | 1) {
  let r = await page.request.post("/api/returns", {
    headers: H("agent", "A001", { "Idempotency-Key": idem }),
    data: { orderId: 1, items: [{ orderItemId: 1, qty }] },
  });
  const id = (await r.json()).data.id;
  await page.request.post(`/api/returns/${id}/sign`, { headers: H("warehouse", "W001") });
  return id;
}

test.describe("缺陷修复", () => {
  test("质检完成后扫码被拒绝，实收/分摊/退款保持不变", async ({ page }) => {
    const id = await keyboardToInspected(page, "fix-after-inspect", 2);
    for (const code of ["KB-A", "KB-B"]) {
      await page.request.post(`/api/returns/${id}/scan`, {
        headers: H("warehouse", "W001"), data: { productId: 1, scanCode: code },
      });
    }
    // 质检：2 件全返库
    let r = await page.request.post(`/api/returns/${id}/inspect`, {
      headers: H("warehouse", "W001"),
      data: { allocations: [{ productId: 1, restockQty: 2, repairQty: 0, scrapQty: 0 }] },
    });
    expect(r.status()).toBe(200);

    // 质检后再扫一个新序列号 -> 拒绝（INVALID_STEP）
    r = await page.request.post(`/api/returns/${id}/scan`, {
      headers: H("warehouse", "W001"), data: { productId: 1, scanCode: "KB-C" },
    });
    expect(r.status()).toBe(409);
    expect((await r.json()).error.code).toBe("INVALID_STEP");

    let d = (await api(page, "GET", `/api/returns/${id}`)).json.data;
    expect(d.items[0].received_qty).toBe(2);          // 实收未增加
    expect(d.items[0].restock_qty).toBe(2);           // 分摊未变
    expect(d.scans).toHaveLength(2);                  // 扫码记录未增加

    // UI：质检后扫码区已隐藏
    await page.locator(".returns-list-table tbody tr.ant-table-row").first().click();
    await expect(page.getByTestId("scan-btn")).toHaveCount(0);

    // 处置后退款应为 2*39900=79800；处置后再扫码同样拒绝，退款不变
    r = await page.request.post(`/api/returns/${id}/dispose`, { headers: H("warehouse", "W001") });
    expect(r.status()).toBe(200);
    expect((await r.json()).data.refund_total_cents).toBe(79800);

    r = await page.request.post(`/api/returns/${id}/scan`, {
      headers: H("warehouse", "W001"), data: { productId: 1, scanCode: "KB-D" },
    });
    expect(r.status()).toBe(409);
    d = (await api(page, "GET", `/api/returns/${id}`)).json.data;
    expect(d.items[0].received_qty).toBe(2);
    expect(d.refund_total_cents).toBe(79800);
    expect(d.scans).toHaveLength(2);
  });

  test("实收数量不得超过申请量：申请1件扫入第2件被拒，且不能超量退款", async ({ page }) => {
    const id = await keyboardToInspected(page, "fix-over-scan", 1);

    let r = await page.request.post(`/api/returns/${id}/scan`, {
      headers: H("warehouse", "W001"), data: { productId: 1, scanCode: "ONE-1" },
    });
    expect(r.status()).toBe(200); // 第 1 件正常

    // 第 2 个不同序列号超出申请量 -> 拒绝
    r = await page.request.post(`/api/returns/${id}/scan`, {
      headers: H("warehouse", "W001"), data: { productId: 1, scanCode: "ONE-2" },
    });
    expect(r.status()).toBe(409);
    expect((await r.json()).error.code).toBe("SCAN_EXCEEDS_REQUESTED");

    // 重复扫第 1 件仍幂等忽略，不改变数量
    r = await page.request.post(`/api/returns/${id}/scan`, {
      headers: H("warehouse", "W001"), data: { productId: 1, scanCode: "ONE-1" },
    });
    expect(r.status()).toBe(200);
    expect((await r.json()).data.duplicate).toBe(true);

    let d = (await api(page, "GET", `/api/returns/${id}`)).json.data;
    expect(d.items[0].received_qty).toBe(1);          // 实收仍为 1
    expect(d.scans).toHaveLength(1);                  // 仅 1 条扫码

    // 质检分摊只能基于实收 1；处置退款 = 1*39900=39900，而非 2 件
    r = await page.request.post(`/api/returns/${id}/inspect`, {
      headers: H("warehouse", "W001"),
      data: { allocations: [{ productId: 1, restockQty: 1, repairQty: 0, scrapQty: 0 }] },
    });
    expect(r.status()).toBe(200);
    r = await page.request.post(`/api/returns/${id}/dispose`, { headers: H("warehouse", "W001") });
    expect((await r.json()).data.refund_total_cents).toBe(39900);
    d = (await api(page, "GET", `/api/returns/${id}`)).json.data;
    expect(d.items[0].received_qty).toBe(1);
  });

  test("生产模式下测试入口（清空数据/故障注入）不开放", async ({ page }) => {
    // 启动一个独立的生产实例（NODE_ENV=production），使用临时数据库与 4200 端口
    const dbPath = join(ROOT, "server", "prod-check.db");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
    const proc = spawn(process.execPath, ["server/index.js"], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: "production", PORT: "4200", RETURNS_DB: dbPath },
      stdio: "ignore",
    });

    const base = "http://localhost:4200";
    // 等待就绪
    for (let i = 0; i < 50; i++) {
      try {
        const probe = await page.request.fetch(`${base}/api/config`);
        if (probe.ok) break;
      } catch { /* retry */ }
      await new Promise((res) => setTimeout(res, 150));
    }

    try {
      // 先建一张单，随后尝试调用「重置」清空——必须失败且数据仍在
      const created = await page.request.post(`${base}/api/returns`, {
        headers: H("agent", "A001", { "Idempotency-Key": "prod-guard-1" }),
        data: { orderId: 1, items: [{ orderItemId: 1, qty: 1 }] },
      });
      expect(created.status()).toBe(200);

      const reset = await page.request.post(`${base}/api/test/reset`, { data: {} });
      expect(reset.status()).toBe(404);

      const fault = await page.request.post(`${base}/api/test/fault`, { data: { failNextCreate: true } });
      expect(fault.status()).toBe(404);

      // 数据未被清空：重置被拒后最初那张单仍在
      let list = await page.request.fetch(`${base}/api/returns`);
      expect((await list.json()).data).toHaveLength(1);

      // 故障注入未生效：随后建单仍成功（而非 INJECTED_FAILURE）
      const created2 = await page.request.post(`${base}/api/returns`, {
        headers: H("agent", "A001", { "Idempotency-Key": "prod-guard-2" }),
        data: { orderId: 1, items: [{ orderItemId: 2, qty: 1 }] },
      });
      expect(created2.status()).toBe(200);
      list = await page.request.fetch(`${base}/api/returns`);
      expect((await list.json()).data).toHaveLength(2);

      // 正常业务路由依然可用
      const cfg = await page.request.fetch(`${base}/api/config`);
      expect(cfg.ok()).toBe(true);
    } finally {
      proc.kill();
      // 等待进程退出后删除临时数据库，避免 -wal 残留
      await new Promise((res) => proc.on("exit", res));
      for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
    }
  });
});
