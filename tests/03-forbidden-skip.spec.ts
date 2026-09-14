import { expect, test, switchRole, gotoOrdersTab, openCreateModal, setReturnQty, submitCreate, openFirstReturn, statusTag, api } from "./helpers";

async function createAndSign(page: Page, idem: string) {
  let r = await api(page, "POST", "/api/returns", {
    role: "agent", actor: "A001", idem,
    body: { orderId: 1, items: [{ orderItemId: 1, qty: 1 }] },
  });
  return r.json.data.id;
}

import type { Page } from "@playwright/test";

test.describe("越权与跳步", () => {
  test("越权：非客服不能建单；非仓库不能签收/质检/处置；非主管不能关闭", async ({ page }) => {
    const id = await createAndSign(page, "fb-1");

    let r = await api(page, "POST", "/api/returns", {
      role: "warehouse", actor: "W001", idem: "fb-w",
      body: { orderId: 1, items: [{ orderItemId: 2, qty: 1 }] },
    });
    expect([r.status, r.json.error.code]).toEqual([403, "FORBIDDEN"]);

    // 客服尝试签收 -> 拒绝
    r = await api(page, "POST", `/api/returns/${id}/sign`, { role: "agent", actor: "A001" });
    expect([r.status, r.json.error.code]).toEqual([403, "FORBIDDEN"]);
    // 主管尝试签收 -> 拒绝
    r = await api(page, "POST", `/api/returns/${id}/sign`, { role: "supervisor", actor: "S001" });
    expect([r.status, r.json.error.code]).toEqual([403, "FORBIDDEN"]);

    // UI：仓库角色下「建立退货单」按钮禁用
    await switchRole(page, "warehouse");
    await gotoOrdersTab(page);
    await expect(page.getByTestId("create-btn-1")).toBeDisabled();

    // 正常签收
    r = await api(page, "POST", `/api/returns/${id}/sign`, { role: "warehouse", actor: "W001" });
    expect(r.status).toBe(200);

    // 客服不能扫码
    r = await api(page, "POST", `/api/returns/${id}/scan`, {
      role: "agent", actor: "A001", body: { productId: 1, scanCode: "Z1" },
    });
    expect([r.status, r.json.error.code]).toEqual([403, "FORBIDDEN"]);

    // 仓库扫码 + 质检后
    await api(page, "POST", `/api/returns/${id}/scan`, {
      role: "warehouse", actor: "W001", body: { productId: 1, scanCode: "Z1" },
    });
    await api(page, "POST", `/api/returns/${id}/inspect`, {
      role: "warehouse", actor: "W001",
      body: { allocations: [{ productId: 1, restockQty: 1, repairQty: 0, scrapQty: 0 }] },
    });

    // 客服不能处置
    r = await api(page, "POST", `/api/returns/${id}/dispose`, { role: "agent", actor: "A001" });
    expect([r.status, r.json.error.code]).toEqual([403, "FORBIDDEN"]);
    // 仓库处置成功
    r = await api(page, "POST", `/api/returns/${id}/dispose`, { role: "warehouse", actor: "W001" });
    expect(r.status).toBe(200);
    // 仓库不能关闭
    r = await api(page, "POST", `/api/returns/${id}/close`, { role: "warehouse", actor: "W001" });
    expect([r.status, r.json.error.code]).toEqual([403, "FORBIDDEN"]);

    // UI：仓库视角关闭按钮禁用
    await page.goto("/");
    await switchRole(page, "warehouse");
    await openFirstReturn(page);
    await expect(page.getByTestId("btn-close")).toBeDisabled();

    // 主管关闭成功
    await switchRole(page, "supervisor");
    await page.getByTestId("btn-close").click();
    await expect(statusTag(page)).toHaveText("已关闭");
  });

  test("跳步：未签收不能质检、未质检不能处置、未处置不能关闭", async ({ page }) => {
    const id = await createAndSign(page, "step-1");

    let r = await api(page, "POST", `/api/returns/${id}/inspect`, {
      role: "warehouse", actor: "W001", body: { allocations: [] },
    });
    expect([r.status, r.json.error.code]).toEqual([409, "INVALID_STEP"]);

    r = await api(page, "POST", `/api/returns/${id}/dispose`, { role: "warehouse", actor: "W001" });
    expect([r.status, r.json.error.code]).toEqual([409, "INVALID_STEP"]);

    r = await api(page, "POST", `/api/returns/${id}/close`, { role: "supervisor", actor: "S001" });
    expect([r.status, r.json.error.code]).toEqual([409, "INVALID_STEP"]);

    // UI：已预约单只出现「签收」，没有质检/处置/关闭按钮
    await page.goto("/");
    await switchRole(page, "warehouse");
    await openFirstReturn(page);
    await expect(page.getByTestId("btn-sign")).toBeVisible();
    await expect(page.getByTestId("btn-inspect")).toHaveCount(0);
    await expect(page.getByTestId("btn-dispose")).toHaveCount(0);
    await expect(page.getByTestId("btn-close")).toHaveCount(0);
  });

  test("质检分摊不等于实收数量被拒绝", async ({ page }) => {
    const id = await createAndSign(page, "alloc-1");
    await api(page, "POST", `/api/returns/${id}/sign`, { role: "warehouse", actor: "W001" });
    await api(page, "POST", `/api/returns/${id}/scan`, {
      role: "warehouse", actor: "W001", body: { productId: 1, scanCode: "A1" },
    });

    // 实收 1，却分 1 返库 + 1 报废 = 2
    let r = await api(page, "POST", `/api/returns/${id}/inspect`, {
      role: "warehouse", actor: "W001",
      body: { allocations: [{ productId: 1, restockQty: 1, repairQty: 0, scrapQty: 1 }] },
    });
    expect([r.status, r.json.error.code]).toEqual([409, "ALLOCATION_MISMATCH"]);
    // 0 分摊也拒绝
    r = await api(page, "POST", `/api/returns/${id}/inspect`, {
      role: "warehouse", actor: "W001",
      body: { allocations: [{ productId: 1, restockQty: 0, repairQty: 0, scrapQty: 0 }] },
    });
    expect([r.status, r.json.error.code]).toEqual([409, "ALLOCATION_MISMATCH"]);
    // 状态仍是已签收
    const d = await api(page, "GET", `/api/returns/${id}`);
    expect(d.json.data.status).toBe("signed");
  });

  test("高金额未复核不能关闭", async ({ page }) => {
    // 显示器
    let r = await api(page, "POST", "/api/returns", {
      role: "agent", actor: "A001", idem: "hi-1",
      body: { orderId: 2, items: [{ orderItemId: 3, qty: 1 }] },
    });
    const id = r.json.data.id;
    await api(page, "POST", `/api/returns/${id}/sign`, { role: "warehouse", actor: "W001" });
    await api(page, "POST", `/api/returns/${id}/scan`, {
      role: "warehouse", actor: "W001", body: { productId: 3, scanCode: "M1" },
    });
    await api(page, "POST", `/api/returns/${id}/inspect`, {
      role: "warehouse", actor: "W001",
      body: { allocations: [{ productId: 3, restockQty: 1, repairQty: 0, scrapQty: 0 }] },
    });
    await api(page, "POST", `/api/returns/${id}/dispose`, { role: "warehouse", actor: "W001" });

    r = await api(page, "POST", `/api/returns/${id}/close`, { role: "supervisor", actor: "S001" });
    expect([r.status, r.json.error.code]).toEqual([409, "PENDING_REVIEW"]);
  });
});
