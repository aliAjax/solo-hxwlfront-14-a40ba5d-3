import { test as base, expect, type Page } from "@playwright/test";

// 每个测试开始前通过真实接口重置数据库（在真实浏览器运行链路内）
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.request.post("/api/test/reset");
    await page.goto("/");
    await use(page);
  },
});

export { expect };

export type Role = "agent" | "warehouse" | "supervisor";

const ROLE_OPTION: Record<Role, string> = {
  agent: "客服 A001",
  warehouse: "仓库 W001",
  supervisor: "主管 S001",
};

export async function switchRole(page: Page, role: Role) {
  await page.getByTestId("role-switch").click();
  await page
    .locator(".ant-select-dropdown .ant-select-item-option", { hasText: ROLE_OPTION[role] })
    .first()
    .click();
}

export async function clickTab(page: Page, label: string) {
  await page.locator(".ant-tabs-tab", { hasText: label }).first().click();
}

export async function gotoOrdersTab(page: Page) {
  await clickTab(page, "原订单");
}

export async function gotoReturnsTab(page: Page) {
  await clickTab(page, "退货单");
}

export async function openCreateModal(page: Page, orderId: number) {
  await page.getByTestId(`create-btn-${orderId}`).click();
}

// 在建单弹窗里设置某订单行的本次退货量
export async function setReturnQty(page: Page, orderItemId: number, qty: number) {
  const input = page.getByTestId(`qty-${orderItemId}`);
  await input.click({ clickCount: 3 });
  await input.fill(String(qty));
  await input.blur();
}

export async function submitCreate(page: Page) {
  await page.getByTestId("submit-create").click();
}

export async function firstReturnNo(page: Page): Promise<string> {
  return (await page.locator(".returns-list-table tbody tr.ant-table-row").first().locator("td").first().textContent()) || "";
}

export async function openFirstReturn(page: Page) {
  await page.locator(".returns-list-table tbody tr.ant-table-row").first().click();
}

// 退货单列表的数据行（排除空表占位行，与订单表、详情表区分开）
export function listRows(page: Page) {
  return page.locator(".returns-list-table tbody tr.ant-table-row");
}

// 详情页头部当前状态标签
export function statusTag(page: Page) {
  return page.getByTestId("detail-status");
}

// 顶部弹出的 toast 提示（与页面内同名状态标签区分开）
export function toast(page: Page) {
  return page.locator(".ant-message-notice-content");
}

// 用真实浏览器上下文的 fetch 直连后端（携带浏览器同源环境）
export async function api(
  page: Page,
  method: string,
  path: string,
  opts: { role?: Role; actor?: string; body?: unknown; idem?: string } = {}
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.role) headers["X-Role"] = opts.role;
  if (opts.actor) headers["X-Actor"] = opts.actor;
  if (opts.idem) headers["Idempotency-Key"] = opts.idem;
  const res = await page.request.fetch(path, {
    method,
    headers,
    data: opts.body as any,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status(), json };
}

export async function toastText(page: Page): Promise<string> {
  const t = await page.locator(".ant-message").last().textContent();
  return t || "";
}
