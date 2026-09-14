import { expect, test, switchRole, gotoOrdersTab, openCreateModal, setReturnQty, submitCreate, openFirstReturn, listRows, statusTag, api } from "./helpers";

test.describe("失败回滚与恢复", () => {
  test("建单写入失败：退货单/商品行/审计全部回滚，且可重试成功", async ({ page }) => {
    // 打开故障注入：下一次建单在事务内抛错
    await api(page, "POST", "/api/test/fault", { body: { failNextCreate: true } });

    const r = await api(page, "POST", "/api/returns", {
      role: "agent", actor: "A001", idem: "rb-create",
      body: { orderId: 1, items: [{ orderItemId: 1, qty: 1 }] },
    });
    expect([r.status, r.json.error.code]).toEqual([500, "INJECTED_FAILURE"]);

    // 列表为空：退货单回滚
    await page.reload();
    await expect(listRows(page)).toHaveCount(0);

    // 审计里没有成功的建单记录（同一事务回滚）
    const audits = await page.request.get("/api/audits").then((x) => x.json());
    const successCreate = audits.data.filter((a: any) => a.action === "create" && a.result === "success");
    expect(successCreate).toHaveLength(0);

    // 同一幂等键重试：失败不占用幂等键，应成功
    const retry = await api(page, "POST", "/api/returns", {
      role: "agent", actor: "A001", idem: "rb-create",
      body: { orderId: 1, items: [{ orderItemId: 1, qty: 1 }] },
    });
    expect(retry.status).toBe(200);
    expect(retry.json.data.status).toBe("booked");
  });

  test("处置写入失败：状态停留质检、处置明细/退款/数量/审计一起回滚", async ({ page }) => {
    // 建单走到 inspected
    let r = await api(page, "POST", "/api/returns", {
      role: "agent", actor: "A001", idem: "rb-dispose",
      body: { orderId: 1, items: [{ orderItemId: 1, qty: 1 }, { orderItemId: 2, qty: 1 }] },
    });
    const id = r.json.data.id;
    await api(page, "POST", `/api/returns/${id}/sign`, { role: "warehouse", actor: "W001" });
    await api(page, "POST", `/api/returns/${id}/scan`, {
      role: "warehouse", actor: "W001", body: { productId: 1, scanCode: "D1" },
    });
    await api(page, "POST", `/api/returns/${id}/scan`, {
      role: "warehouse", actor: "W001", body: { productId: 2, scanCode: "D2" },
    });
    await api(page, "POST", `/api/returns/${id}/inspect`, {
      role: "warehouse", actor: "W001",
      body: {
        allocations: [
          { productId: 1, restockQty: 1, repairQty: 0, scrapQty: 0 },
          { productId: 2, restockQty: 0, repairQty: 1, scrapQty: 0 },
        ],
      },
    });

    // 故障注入后处置失败
    await api(page, "POST", "/api/test/fault", { body: { failNextDispose: true } });
    r = await api(page, "POST", `/api/returns/${id}/dispose`, { role: "warehouse", actor: "W001" });
    expect([r.status, r.json.error.code]).toEqual([500, "INJECTED_FAILURE"]);

    const d = (await api(page, "GET", `/api/returns/${id}`)).json.data;
    // 状态回滚
    expect(d.status).toBe("inspected");
    // 处置明细、退款回滚
    expect(d.dispositions).toHaveLength(0);
    expect(d.refund).toBeNull();
    expect(d.refund_total_cents).toBe(0);
    // 数量回滚：refund_cents 未被写入
    expect(d.items.every((i: any) => i.refund_cents === 0)).toBe(true);
    // 审计中没有成功处置
    const audits = await page.request.get(`/api/audits?returnId=${id}`).then((x) => x.json());
    expect(audits.data.filter((a: any) => a.action === "dispose")).toHaveLength(0);

    // 重试处置成功（真实金额：键盘全退 399 + 鼠标维修 129*30%=38.7 = ¥437.70）
    const retry = await api(page, "POST", `/api/returns/${id}/dispose`, { role: "warehouse", actor: "W001" });
    expect(retry.status).toBe(200);
    expect(retry.json.data.refund_total_cents).toBe(39900 + Math.round(12900 * 0.3));
  });

  test("故障标志一次性、不影响后续正常请求", async ({ page }) => {
    await api(page, "POST", "/api/test/fault", { body: { failNextCreate: true } });
    const r1 = await api(page, "POST", "/api/returns", {
      role: "agent", actor: "A001", idem: "oneshot",
      body: { orderId: 1, items: [{ orderItemId: 2, qty: 1 }] },
    });
    // 第一次被注入故障并整体回滚
    expect([r1.status, r1.json.error.code]).toEqual([500, "INJECTED_FAILURE"]);
    // 第二张进入正常校验并成功（回滚无残留，且故障只生效一次）
    const r2 = await api(page, "POST", "/api/returns", {
      role: "agent", actor: "A001", idem: "oneshot-2",
      body: { orderId: 1, items: [{ orderItemId: 2, qty: 1 }] },
    });
    expect([r2.status, r2.json.data.status]).toEqual([200, "booked"]);
  });

  test("UI 下处置失败后刷新，页面仍停留在质检阶段且无退款", async ({ page }) => {
    let r = await api(page, "POST", "/api/returns", {
      role: "agent", actor: "A001", idem: "ui-rb",
      body: { orderId: 2, items: [{ orderItemId: 3, qty: 1 }] },
    });
    const id = r.json.data.id;
    await api(page, "POST", `/api/returns/${id}/sign`, { role: "warehouse", actor: "W001" });
    await api(page, "POST", `/api/returns/${id}/scan`, {
      role: "warehouse", actor: "W001", body: { productId: 3, scanCode: "U1" },
    });
    await api(page, "POST", `/api/returns/${id}/inspect`, {
      role: "warehouse", actor: "W001",
      body: { allocations: [{ productId: 3, restockQty: 1, repairQty: 0, scrapQty: 0 }] },
    });
    await api(page, "POST", "/api/test/fault", { body: { failNextDispose: true } });

    // 在真实页面上以仓库身份点击处置，看到失败提示
    await page.goto("/");
    await switchRole(page, "warehouse");
    await openFirstReturn(page);
    await page.getByTestId("btn-dispose").click();
    await expect(page.getByText(/操作被拒绝.*故障注入/)).toBeVisible();
    // 仍是「已质检」标签
    await expect(statusTag(page)).toBeVisible();

    // 刷新后完整恢复到质检阶段、退款为 ¥0.00
    await page.reload();
    await openFirstReturn(page);
    await expect(statusTag(page)).toBeVisible();
    await expect(page.getByText("¥0.00").first()).toBeVisible();
    await expect(page.getByTestId("btn-dispose")).toBeVisible();
  });
});
