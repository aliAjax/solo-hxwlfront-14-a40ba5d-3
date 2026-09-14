import { useState } from "react";
import {
  Steps, Table, Tag, Button, Space, Card, Select, Input, Modal, InputNumber,
  Descriptions, Alert, App, Popconfirm,
} from "antd";
import {
  api, yuan, type ReturnOrder, type Role,
} from "../api";

const STATUS_STEP: Record<string, number> = {
  booked: 0, signed: 1, inspected: 2, disposed: 3, closed: 4,
};
const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  booked: { text: "已预约", color: "blue" },
  signed: { text: "已签收", color: "cyan" },
  inspected: { text: "已质检", color: "gold" },
  disposed: { text: "已处置", color: "geekblue" },
  closed: { text: "已关闭", color: "green" },
};

interface Props {
  detail: ReturnOrder;
  role: Role;
  threshold: number;
  reload: () => void;
}

export default function ReturnDetail({ detail, role, threshold, reload }: Props) {
  const { message } = App.useApp();
  const [scanProduct, setScanProduct] = useState<number | undefined>();
  const [scanCode, setScanCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [alloc, setAlloc] = useState<Record<number, { r: number; p: number; s: number }>>({});

  const run = async (p: Promise<unknown>, success: string) => {
    try {
      await p;
      message.success(success);
      reload();
    } catch (e: any) {
      message.error({ content: `操作被拒绝：${e.message}`, duration: 4 });
    }
  };

  const status = detail.status;
  const step = STATUS_STEP[status];

  const doScan = async () => {
    if (!scanProduct) return message.warning("请选择商品");
    if (!scanCode.trim()) return message.warning("请输入或扫描序列号");
    setBusy(true);
    try {
      const res = await api.scan(detail.id, scanProduct, scanCode.trim());
      if (res.duplicate) message.warning("重复扫码，只记一次（不增加实收）");
      else message.success(`扫码成功：${scanCode.trim()}`);
      setScanCode("");
      reload();
    } catch (e: any) {
      message.error(`扫码被拒绝：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const openInspect = () => {
    const init: Record<number, { r: number; p: number; s: number }> = {};
    for (const it of detail.items) {
      init[it.product_id] = {
        r: it.restock_qty || 0,
        p: it.repair_qty || 0,
        s: it.scrap_qty || 0,
      };
    }
    setAlloc(init);
    setInspectOpen(true);
  };

  const submitInspect = async () => {
    const payload = detail.items.map((it) => {
      const a = alloc[it.product_id] || { r: 0, p: 0, s: 0 };
      return { productId: it.product_id, restockQty: a.r, repairQty: a.p, scrapQty: a.s };
    });
    const bad = detail.items.find((it) => {
      const a = alloc[it.product_id] || { r: 0, p: 0, s: 0 };
      return a.r + a.p + a.s !== it.received_qty;
    });
    if (bad) return message.error(`商品 ${bad.name} 的三类分摊合计必须恰好等于实收数量 ${bad.received_qty}`);
    setBusy(true);
    try {
      await api.inspect(detail.id, payload);
      message.success("质检完成");
      setInspectOpen(false);
      reload();
    } catch (e: any) {
      message.error(`质检被拒绝：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const refundPending =
    detail.needs_supervisor === 1 &&
    detail.refund?.status !== "approved";

  return (
    <Card
      title={
        <Space wrap>
          <span data-testid="detail-title">退货单 {detail.return_no}</span>
          <Tag data-testid="detail-status" color={STATUS_LABEL[status].color}>{STATUS_LABEL[status].text}</Tag>
          {detail.needs_supervisor === 1 && (
            <Tag color="volcano">高金额·待主管复核</Tag>
          )}
        </Space>
      }
    >
      <Steps
        current={step}
        size="small"
        style={{ marginBottom: 20 }}
        items={[
          { title: "预约" },
          { title: "签收" },
          { title: "质检" },
          { title: "处置" },
          { title: "关闭" },
        ]}
      />

      <Descriptions size="small" column={3} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="原订单">{detail.order.order_no}</Descriptions.Item>
        <Descriptions.Item label="客户">{detail.order.customer}</Descriptions.Item>
        <Descriptions.Item label="建单人">{detail.created_by}</Descriptions.Item>
        <Descriptions.Item label="最近操作人">{detail.current_step_by ?? "-"}</Descriptions.Item>
        <Descriptions.Item label="退款合计">
          <b data-testid="refund-total">{yuan(detail.refund_total_cents)}</b>
        </Descriptions.Item>
        <Descriptions.Item label="复核状态">
          {detail.refund ? (
            <Tag color={detail.refund.status === "approved" ? "green" : detail.refund.status === "rejected" ? "red" : "orange"}>
              {detail.refund.status === "approved" ? "已通过" : detail.refund.status === "rejected" ? "已驳回" : "待复核"}
            </Tag>
          ) : "-"}
        </Descriptions.Item>
      </Descriptions>

      <Table
        rowKey="id"
        className="detail-items-table"
        size="small"
        pagination={false}
        dataSource={detail.items}
        style={{ marginBottom: 16 }}
        columns={[
          { title: "商品", dataIndex: "name" },
          { title: "申请量", dataIndex: "qty", width: 70 },
          { title: "实收", dataIndex: "received_qty", width: 70,
            render: (v: number) => <b style={{ color: v > 0 ? "#1677ff" : undefined }}>{v}</b> },
          { title: "返库", dataIndex: "restock_qty", width: 70 },
          { title: "维修", dataIndex: "repair_qty", width: 70 },
          { title: "报废", dataIndex: "scrap_qty", width: 70 },
          { title: "单价", dataIndex: "unit_price_cents", width: 90, render: (v: number) => yuan(v) },
          { title: "退款", dataIndex: "refund_cents", width: 100, render: (v: number) => yuan(v) },
        ]}
      />

      {/* 扫码区：仅签收后、质检前可用 */}
      {status === "signed" && (
        <Card size="small" type="inner" title="包裹扫码（重复扫码只记一次）" style={{ marginBottom: 16 }}>
          <Space wrap>
            <Select
              data-testid="scan-product"
              style={{ width: 220 }}
              placeholder="选择商品"
              value={scanProduct}
              onChange={setScanProduct}
              options={detail.items.map((i) => ({ value: i.product_id, label: `${i.name}（已收 ${i.received_qty}）` }))}
            />
            <Input
              data-testid="scan-code"
              style={{ width: 220 }}
              placeholder="序列号，如 SN-1001"
              value={scanCode}
              onPressEnter={doScan}
              onChange={(e) => setScanCode(e.target.value)}
            />
            <Button data-testid="scan-btn" type="primary" loading={busy} onClick={doScan}>
              扫码
            </Button>
          </Space>
        </Card>
      )}

      {/* 操作区：严格按状态机与角色显示 */}
      <Space wrap style={{ marginTop: 8 }}>
        {status === "booked" && (
          <Button
            data-testid="btn-sign"
            type="primary"
            disabled={role !== "warehouse"}
            title={role !== "warehouse" ? "仅仓库人员可签收" : ""}
            onClick={() => run(api.sign(detail.id), "已签收")}
          >
            签收包裹
          </Button>
        )}

        {status === "signed" && (
          <Button
            data-testid="btn-inspect"
            type="primary"
            disabled={role !== "warehouse"}
            title={role !== "warehouse" ? "仅仓库人员可质检" : ""}
            onClick={openInspect}
          >
            质检分摊
          </Button>
        )}

        {status === "inspected" && (
          <Button
            data-testid="btn-dispose"
            type="primary"
            disabled={role !== "warehouse" && role !== "supervisor"}
            onClick={() => run(api.dispose(detail.id), "处置完成，退款已计算")}
          >
            确认处置并计算退款
          </Button>
        )}

        {status === "disposed" && (
          <>
            {refundPending && role === "supervisor" && (
              <>
                <Popconfirm
                  title="复核通过该高金额退款？"
                  onConfirm={() => run(api.review(detail.id, "approved"), "复核通过")}
                >
                  <Button data-testid="btn-approve" type="primary">主管复核通过</Button>
                </Popconfirm>
                <Button danger data-testid="btn-reject"
                  onClick={() => run(api.review(detail.id, "rejected"), "已驳回")}>
                  驳回
                </Button>
              </>
            )}
            <Button
              data-testid="btn-close"
              type="primary"
              ghost
              disabled={role !== "supervisor"}
              title={role !== "supervisor" ? "仅主管可关闭" : ""}
              onClick={() => run(api.close(detail.id), "退货单已关闭")}
            >
              关闭退货单
            </Button>
          </>
        )}
      </Space>

      {refundPending && role !== "supervisor" && (
        <Alert
          style={{ marginTop: 16 }}
          type="warning"
          showIcon
          message={`退款 ${yuan(detail.refund_total_cents)} 达到复核阈值 ${yuan(threshold)}，需切换为主管复核后才能关闭。`}
        />
      )}

      <Modal
        title="质检：实收数量完整分摊"
        open={inspectOpen}
        onCancel={() => setInspectOpen(false)}
        onOk={submitInspect}
        confirmLoading={busy}
        okText="完成质检"
        okButtonProps={{ "data-testid": "submit-inspect" }}
      >
        <Table
          rowKey="product_id"
          size="small"
          pagination={false}
          dataSource={detail.items}
          columns={[
            { title: "商品", dataIndex: "name" },
            { title: "实收", dataIndex: "received_qty", width: 60 },
            {
              title: "返库", width: 100,
              render: (_, r) => (
                <InputNumber data-testid={`alloc-r-${r.product_id}`} min={0}
                  value={alloc[r.product_id]?.r ?? 0}
                  onChange={(v) => setAlloc((m) => ({ ...m, [r.product_id]: { ...m[r.product_id], r: Number(v) || 0, p: m[r.product_id]?.p ?? 0, s: m[r.product_id]?.s ?? 0 } }))} />
              ),
            },
            {
              title: "维修", width: 100,
              render: (_, r) => (
                <InputNumber data-testid={`alloc-p-${r.product_id}`} min={0}
                  value={alloc[r.product_id]?.p ?? 0}
                  onChange={(v) => setAlloc((m) => ({ ...m, [r.product_id]: { ...m[r.product_id], r: m[r.product_id]?.r ?? 0, p: Number(v) || 0, s: m[r.product_id]?.s ?? 0 } }))} />
              ),
            },
            {
              title: "报废", width: 100,
              render: (_, r) => (
                <InputNumber data-testid={`alloc-s-${r.product_id}`} min={0}
                  value={alloc[r.product_id]?.s ?? 0}
                  onChange={(v) => setAlloc((m) => ({ ...m, [r.product_id]: { ...m[r.product_id], r: m[r.product_id]?.r ?? 0, p: m[r.product_id]?.p ?? 0, s: Number(v) || 0 } }))} />
              ),
            },
            {
              title: "合计", width: 70,
              render: (_, r) => {
                const a = alloc[r.product_id] || { r: 0, p: 0, s: 0 };
                const sum = a.r + a.p + a.s;
                return <Tag color={sum === r.received_qty ? "green" : "red"}>{sum}/{r.received_qty}</Tag>;
              },
            },
          ]}
        />
        <p style={{ marginTop: 12, color: "#888" }}>
          返库=全额退款，维修=按 30% 退款，报废=不退。三类合计必须恰好等于实收数量。
        </p>
      </Modal>
    </Card>
  );
}
