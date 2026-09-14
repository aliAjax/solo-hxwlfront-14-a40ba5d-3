import { useRef, useState } from "react";
import { Modal, Table, InputNumber, Tag, App } from "antd";
import type { Order } from "../api";
import { api, idemKey } from "../api";

interface Props {
  order: Order;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export default function CreateReturnModal({ order, open, onClose, onCreated }: Props) {
  const { message } = App.useApp();
  // orderItemId -> 申请数量
  const [qtyMap, setQtyMap] = useState<Record<number, number>>({});
  const [submitting, setSubmitting] = useState(false);
  // 用 ref 做同步上锁：双击/连击的第二次调用在重渲染前也会被拦下
  const lockRef = useRef(false);
  // 同一次打开共用一个幂等键，任何重试/重复提交都只产生一张单
  const keyRef = useRef("");

  const reset = () => {
    setQtyMap({});
    keyRef.current = "";
    lockRef.current = false;
    setSubmitting(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    if (lockRef.current) return; // 重复提交直接忽略
    const items = Object.entries(qtyMap)
      .map(([id, qty]) => ({ orderItemId: Number(id), qty }))
      .filter((x) => x.qty > 0);
    if (items.length === 0) {
      message.warning("请至少选择一个商品并填写数量");
      return;
    }
    lockRef.current = true;
    const useKey = keyRef.current || idemKey();
    keyRef.current = useKey;
    setSubmitting(true);
    try {
      const ro = await api.createReturn(order.id, items, useKey);
      message.success(`退货单 ${ro.return_no} 已建立（已预约）`);
      onCreated();
      close();
    } catch (e: any) {
      message.error(`建单被拒绝：${e.message}`);
      lockRef.current = false; // 失败后允许用同一幂等键重试
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={`建立退货单 · 原订单 ${order.order_no}（${order.customer}）`}
      open={open}
      onCancel={close}
      onOk={submit}
      okText="提交退货申请"
      confirmLoading={submitting}
      okButtonProps={{ "data-testid": "submit-create" }}
      width={720}
      destroyOnClose
    >
      <Table
        rowKey="id"
        pagination={false}
        size="small"
        dataSource={order.items}
        columns={[
          { title: "商品", dataIndex: "name" },
          { title: "SKU", dataIndex: "sku" },
          {
            title: "购买量",
            dataIndex: "qty",
            width: 80,
          },
          {
            title: "累计已退",
            dataIndex: "returned_qty",
            width: 90,
            render: (v: number) => <Tag color={v > 0 ? "orange" : "default"}>{v}</Tag>,
          },
          {
            title: "在途",
            dataIndex: "in_transit_qty",
            width: 80,
            render: (v: number) => (v > 0 ? <Tag color="red">{v}</Tag> : <Tag>0</Tag>),
          },
          {
            title: "本次退货量",
            width: 130,
            render: (_, r) => {
              const remaining = r.qty - r.returned_qty;
              const inTransit = r.in_transit_qty > 0;
              return (
                <InputNumber
                  data-testid={`qty-${r.id}`}
                  min={0}
                  max={remaining}
                  disabled={inTransit || remaining <= 0}
                  value={qtyMap[r.id] ?? 0}
                  onChange={(v) => setQtyMap((m) => ({ ...m, [r.id]: Number(v) || 0 }))}
                />
              );
            },
          },
        ]}
      />
      <p style={{ marginTop: 12, color: "#888" }}>
        可退上限 = 购买量 − 累计已退；存在「在途」退货单的商品不可重复申请。提交带幂等键，重复点击只生效一次。
      </p>
    </Modal>
  );
}
