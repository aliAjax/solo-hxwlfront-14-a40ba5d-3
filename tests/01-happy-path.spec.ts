import { expect, test, switchRole, gotoOrdersTab, gotoReturnsTab, openCreateModal, setReturnQty, submitCreate, openFirstReturn, listRows, statusTag, toast } from "./helpers";

// 正常流程：客服建单 -> 仓库签收/扫码(去重)/质检分摊 -> 处置算退款 -> 主管关闭；刷新恢复
test.describe("正常流程与恢复", () => {
  test("完整流转 + 重复扫码只记一次 + 刷新后数据完整恢复", async ({ page }) => {
    // 1. 客服建单：键盘 x2、鼠标 x2（原订单 SO-1001，order item id 1/2）
    await switchRole(page, "agent");
    await gotoOrdersTab(page);
    await openCreateModal(page, 1);
    await setReturnQty(page, 1, 2);
    await setReturnQty(page, 2, 2);
    await submitCreate(page);
    await gotoReturnsTab(page);
    await expect(toast(page).getByText(/已建立（已预约）/)).toBeVisible();

    // 列表出现一张「已预约」单
    await expect(listRows(page).first()).toContainText("已预约");
    await openFirstReturn(page);
    await expect(page.locator(".ant-steps-item-active")).toContainText("预约");

    // 2. 切到仓库签收
    await switchRole(page, "warehouse");
    await page.getByTestId("btn-sign").click();
    await expect(toast(page).getByText(/已签收/)).toBeVisible();

    // 3. 扫码：键盘扫 2 个序列号，再重复扫同一个 -> 实收仍为 2
    await page.getByTestId("scan-product").click();
    await page.locator(".ant-select-dropdown .ant-select-item-option", { hasText: "机械键盘" }).click();
    await page.getByTestId("scan-code").fill("KB-001");
    await page.getByTestId("scan-btn").click();
    await expect(toast(page).getByText(/扫码成功：KB-001/)).toBeVisible();

    await page.getByTestId("scan-code").fill("KB-002");
    await page.getByTestId("scan-btn").click();
    await expect(toast(page).getByText(/扫码成功：KB-002/)).toBeVisible();

    // 重复扫码
    await page.getByTestId("scan-code").fill("KB-001");
    await page.getByTestId("scan-btn").click();
    await expect(toast(page).getByText(/重复扫码，只记一次/)).toBeVisible();

    // 鼠标扫 2 个（每次扫码后数据刷新，重新选择商品并等待成功提示）
    await page.getByTestId("scan-product").click();
    await page.locator(".ant-select-dropdown .ant-select-item-option", { hasText: "无线鼠标" }).click();
    await page.getByTestId("scan-code").fill("MS-001");
    await page.getByTestId("scan-btn").click();
    await expect(toast(page).getByText(/扫码成功：MS-001/)).toBeVisible();

    await page.getByTestId("scan-product").click();
    await page.locator(".ant-select-dropdown .ant-select-item-option", { hasText: "无线鼠标" }).click();
    await page.getByTestId("scan-code").fill("MS-002");
    await page.getByTestId("scan-btn").click();
    await expect(toast(page).getByText(/扫码成功：MS-002/)).toBeVisible();

    // 表格里键盘实收=2，鼠标实收=2
    const rows = page.locator(".detail-items-table tbody tr");
    await expect(rows.filter({ hasText: "机械键盘" })).toContainText("2");
    await expect(rows.filter({ hasText: "无线鼠标" })).toContainText("2");

    // 4. 质检分摊：键盘 2 全返库；鼠标 1 返库 + 1 维修
    await page.getByTestId("btn-inspect").click();
    // 键盘默认 0，设置返库 2
    await page.getByTestId("alloc-r-1").fill("2");
    // 鼠标返库 1、维修 1（product_id=2）
    await page.getByTestId("alloc-r-2").fill("1");
    await page.getByTestId("alloc-p-2").fill("1");
    await page.getByTestId("submit-inspect").click();
    await expect(toast(page).getByText(/质检完成/)).toBeVisible();

    // 5. 处置并计算退款：2*39900 + 1*12900 + 1*3870 = 96570 分 = ¥965.70（低于阈值，无需复核）
    await page.getByTestId("btn-dispose").click();
    await expect(toast(page).getByText(/处置完成，退款已计算/)).toBeVisible();
    await expect(page.getByTestId("refund-total")).toHaveText("¥965.70");
    await expect(page.getByText(/高金额/)).toHaveCount(0);

    // 6. 仓库无权关闭（按钮禁用）；切主管关闭
    await expect(page.getByTestId("btn-close")).toBeDisabled();
    await switchRole(page, "supervisor");
    await page.getByTestId("btn-close").click();
    await expect(toast(page).getByText(/退货单已关闭/)).toBeVisible();
    await expect(statusTag(page)).toBeVisible();

    // 7. 刷新：数据从服务端完整恢复
    await page.reload();
    await expect(listRows(page).first()).toContainText("已关闭");
    await openFirstReturn(page);
    await expect(statusTag(page)).toBeVisible();
    await expect(page.getByTestId("refund-total")).toHaveText("¥965.70");
    await expect(page.locator(".ant-steps-item-active")).toContainText("关闭");
    await expect(page.locator(".detail-items-table tbody tr").filter({ hasText: "机械键盘" })).toContainText("2");
  });

  test("高金额退款需主管复核后才能关闭", async ({ page }) => {
    // 显示器 1899.00 全返库，超过 1000.00 阈值
    await switchRole(page, "agent");
    await gotoOrdersTab(page);
    await openCreateModal(page, 2);
    await setReturnQty(page, 3, 1);
    await submitCreate(page);
    await gotoReturnsTab(page);
    await openFirstReturn(page);

    await switchRole(page, "warehouse");
    await page.getByTestId("btn-sign").click();
    await page.getByTestId("scan-product").click();
    await page.locator(".ant-select-dropdown .ant-select-item-option", { hasText: "显示器" }).click();
    await page.getByTestId("scan-code").fill("MN-001");
    await page.getByTestId("scan-btn").click();
    await expect(toast(page).getByText(/扫码成功：MN-001/)).toBeVisible();
    await expect(
      page.locator(".detail-items-table tbody tr").filter({ hasText: "显示器" })
    ).toContainText("1");
    await page.getByTestId("btn-inspect").click();
    await page.getByTestId("alloc-r-3").fill("1");
    await page.getByTestId("submit-inspect").click();
    await expect(toast(page).getByText(/质检完成/)).toBeVisible();
    await page.getByTestId("btn-dispose").click();

    await expect(page.getByText(/高金额·待主管复核/)).toBeVisible();
    await expect(page.getByTestId("refund-total")).toHaveText("¥1899.00");

    // 主管复核通过
    await switchRole(page, "supervisor");
    await page.getByTestId("btn-approve").click();
    await page.locator(".ant-popconfirm-buttons .ant-btn-primary").click();
    await expect(toast(page).getByText(/复核通过/)).toBeVisible();
    // 然后才能关闭
    await page.getByTestId("btn-close").click();
    await expect(statusTag(page)).toBeVisible();
  });
});
