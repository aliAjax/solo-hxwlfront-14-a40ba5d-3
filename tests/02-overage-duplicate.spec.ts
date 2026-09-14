import { expect, test, switchRole, gotoOrdersTab, openCreateModal, setReturnQty, submitCreate, openFirstReturn, listRows, api } from "./helpers";

test.describe("累计超量与重复提交", () => {
  test("累计退货量不能超过购买量（服务端强校验 + UI 上限）", async ({ page }) => {
    // 先通过真实浏览器网络请求建一张键盘 x1 并走完关闭（购买量=2，已退1，还可退1）
    let r = await api(page, "POST", "/api/returns", {
      role: "agent", actor: "A001", idem: "ov-1",
      body: { orderId: 1, items: [{ orderItemId: 1, qty: 1 }] },
    });
    expect(r.status).toBe(200);
    const id = r.json.data.id;
    await api(page, "POST", `/api/returns/${id}/sign`, { role: "warehouse", actor: "W001" });
    await api(page, "POST", `/api/returns/${id}/scan`, {
      role: "warehouse", actor: "W001", body: { productId: 1, scanCode: "S1" },
    });
    await api(page, "POST", `/api/returns/${id}/inspect`, {
      role: "warehouse", actor: "W001",
      body: { allocations: [{ productId: 1, restockQty: 1, repairQty: 0, scrapQty: 0 }] },
    });
    await api(page, "POST", `/api/returns/${id}/dispose`, { role: "warehouse", actor: "W001" });
    await api(page, "POST", `/api/returns/${id}/close`, { role: "supervisor", actor: "S001" });

    // 再申请键盘 2 件：累计 1+2=3 > 购买量 2 -> 服务端直接拒绝
    r = await api(page, "POST", "/api/returns", {
      role: "agent", actor: "A001", idem: "ov-2",
      body: { orderId: 1, items: [{ orderItemId: 1, qty: 2 }] },
    });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("OVER_PURCHASED");

    // UI：再开建单弹窗，键盘可退上限只剩 1（max=1），无法输入超过上限
    await switchRole(page, "agent");
    await gotoOrdersTab(page);
    await openCreateModal(page, 1);
    const kbInput = page.getByTestId("qty-1");
    await kbInput.click({ clickCount: 3 });
    await kbInput.fill("2");
    await kbInput.blur();
    await expect(kbInput).toHaveValue("1"); // 被上限钳制
    // 只退 1 件是允许的（恰好等于购买量）
    await setReturnQty(page, 1, 1);
    await submitCreate(page);
    await expect(listRows(page).first()).toContainText("已预约");
  });

  test("同一在途商品不能重复申请（UI 禁用 + 服务端 409）", async ({ page }) => {
    await switchRole(page, "agent");
    await gotoOrdersTab(page);
    await openCreateModal(page, 1);
    await setReturnQty(page, 1, 1);
    await submitCreate(page);
    await expect(listRows(page).first()).toContainText("已预约");

    // 再次建单：键盘存在在途退货，数量框被禁用
    await gotoOrdersTab(page);
    await openCreateModal(page, 1);
    await expect(page.getByTestId("qty-1")).toBeDisabled();

    // 绕过 UI 直接请求也被服务端拒绝
    const r = await api(page, "POST", "/api/returns", {
      role: "agent", actor: "A001", idem: "dup-intransit",
      body: { orderId: 1, items: [{ orderItemId: 1, qty: 1 }] },
    });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("IN_TRANSIT_DUP");
  });

  test("同一幂等键并发重复提交只产生一张退货单", async ({ page }) => {
    // 两个几乎同时到达、使用相同幂等键的请求
    const [a, b] = await Promise.all([
      api(page, "POST", "/api/returns", {
        role: "agent", actor: "A001", idem: "same-key",
        body: { orderId: 1, items: [{ orderItemId: 2, qty: 1 }] },
      }),
      api(page, "POST", "/api/returns", {
        role: "agent", actor: "A001", idem: "same-key",
        body: { orderId: 1, items: [{ orderItemId: 2, qty: 1 }] },
      }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.json.data.id).toBe(b.json.data.id);

    await page.reload();
    // 列表只有一张单
    await expect(listRows(page)).toHaveCount(1);
  });

  test("UI 双击提交只建立一张单", async ({ page }) => {
    await switchRole(page, "agent");
    await gotoOrdersTab(page);
    await openCreateModal(page, 1);
    await setReturnQty(page, 2, 1);
    const btn = page.getByTestId("submit-create");
    // 不等待地连续触发两次点击
    await Promise.all([btn.click(), btn.click().catch(() => {})]);
    await expect(listRows(page)).toHaveCount(1);
  });
});
