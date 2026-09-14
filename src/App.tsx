import { useCallback, useEffect, useState } from "react";
import {
  Layout, Select, Table, Tag, Button, Space, Tabs, Card, Spin, Empty,
} from "antd";
import {
  api, setIdentity, type Order, type ReturnOrder, type AuditRow, type Role,
} from "./api";
import CreateReturnModal from "./components/CreateReturnModal";
import ReturnDetail from "./components/ReturnDetail";
import AuditLog from "./components/AuditLog";

const ROLE_LABEL: Record<Role, string> = {
  agent: "客服 A001",
  warehouse: "仓库 W001",
  supervisor: "主管 S001",
};
const ROLE_ACTOR: Record<Role, string> = {
  agent: "A001", warehouse: "W001", supervisor: "S001",
};
const STATUS: Record<string, { text: string; color: string }> = {
  booked: { text: "已预约", color: "blue" },
  signed: { text: "已签收", color: "cyan" },
  inspected: { text: "已质检", color: "gold" },
  disposed: { text: "已处置", color: "geekblue" },
  closed: { text: "已关闭", color: "green" },
};

export default function App() {
  const [role, setRole] = useState<Role>("agent");
  const [orders, setOrders] = useState<Order[]>([]);
  const [list, setList] = useState<{ id: number; return_no: string; status: string; order_id: number }[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ReturnOrder | null>(null);
  const [audits, setAudits] = useState<AuditRow[]>([]);
  const [threshold, setThreshold] = useState(100000);
  const [createOrder, setCreateOrder] = useState<Order | null>(null);
  const [tab, setTab] = useState("returns");
  const [loading, setLoading] = useState(false);

  const changeRole = (r: Role) => {
    setRole(r);
    setIdentity({ actor: ROLE_ACTOR[r], role: r });
  };

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const [os, rs, au, cfg] = await Promise.all([
        api.orders(), api.returns(), api.audits(), api.config(),
      ]);
      setOrders(os);
      setList(rs);
      setAudits(au);
      setThreshold(cfg.refundReviewThresholdCents);
      if (selectedId) {
        const fresh = await api.returnDetail(selectedId).catch(() => null);
        setDetail(fresh);
      }
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    setIdentity({ actor: ROLE_ACTOR[role], role });
  }, [role]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshAll();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openReturn = async (id: number) => {
    setSelectedId(id);
    setDetail(await api.returnDetail(id));
    setTab("returns");
  };

  const orderNo = (oid: number) => orders.find((o) => o.id === oid)?.order_no ?? `#${oid}`;

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingInline: 24 }}>
        <div style={{ color: "#fff", fontWeight: 700, fontSize: 18 }}>退货质检与处置台</div>
        <Space>
          <span style={{ color: "rgba(255,255,255,.75)" }}>当前身份</span>
          <Select
            data-testid="role-switch"
            value={role}
            style={{ width: 160 }}
            onChange={changeRole}
            options={(Object.keys(ROLE_LABEL) as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
          />
        </Space>
      </Layout.Header>

      <Layout.Content style={{ padding: 24 }}>
        <Spin spinning={loading}>
          <Tabs
            activeKey={tab}
            onChange={setTab}
            items={[
              {
                key: "returns",
                label: "退货单",
                children: (
                  <Space direction="vertical" style={{ width: "100%" }} size={16}>
                    <Card size="small" title="退货单列表">
                      <Table
                        rowKey="id"
                        className="returns-list-table"
                        size="small"
                        pagination={false}
                        dataSource={list}
                        locale={{ emptyText: <Empty description="暂无退货单，请到「原订单」建单" /> }}
                        onRow={(r) => ({ onClick: () => openReturn(r.id), style: { cursor: "pointer" } })}
                        columns={[
                          { title: "退货单号", dataIndex: "return_no", render: (v: string) => <a>{v}</a> },
                          { title: "原订单", dataIndex: "order_id", render: (v: number) => orderNo(v) },
                          {
                            title: "状态", dataIndex: "status", width: 120,
                            render: (s: string) => <Tag color={STATUS[s].color}>{STATUS[s].text}</Tag>,
                          },
                          { title: "ID", dataIndex: "id", width: 70 },
                        ]}
                      />
                    </Card>

                    {detail ? (
                      <ReturnDetail
                        key={detail.id}
                        detail={detail}
                        role={role}
                        threshold={threshold}
                        reload={refreshAll}
                      />
                    ) : (
                      <Card><Empty description="点击上方退货单查看流转详情" /></Card>
                    )}
                  </Space>
                ),
              },
              {
                key: "orders",
                label: "原订单 / 建退货单",
                children: (
                  <Card title="原订单（客服选择商品与数量建立退货单）">
                    <Table
                      rowKey="id"
                      size="small"
                      pagination={false}
                      dataSource={orders}
                      columns={[
                        { title: "订单号", dataIndex: "order_no" },
                        { title: "客户", dataIndex: "customer", width: 120 },
                        {
                          title: "商品明细",
                          dataIndex: "items",
                          render: (items: Order["items"]) =>
                            items.map((i) => (
                              <Tag key={i.id} style={{ marginBottom: 4 }}>
                                {i.name} ×{i.qty}
                                {i.in_transit_qty > 0 ? `（在途${i.in_transit_qty}）` : ""}
                                {i.returned_qty > 0 ? ` 已退${i.returned_qty}` : ""}
                              </Tag>
                            )),
                        },
                        {
                          title: "操作", width: 160,
                          render: (_, o) => (
                            <Button
                              data-testid={`create-btn-${o.id}`}
                              type="primary"
                              ghost
                              disabled={role !== "agent"}
                              onClick={() => setCreateOrder(o)}
                            >
                              建立退货单
                            </Button>
                          ),
                        },
                      ]}
                    />
                    <p style={{ marginTop: 12, color: "#888" }}>
                      仅客服可建单；累计退货量不能超过购买量；存在在途退货单的商品不能重复申请。
                    </p>
                  </Card>
                ),
              },
              {
                key: "audit",
                label: "审计日志",
                children: (
                  <Card title="审计日志（成功 / 拒绝 / 失败留痕）">
                    <AuditLog rows={audits} />
                  </Card>
                ),
              },
            ]}
          />
        </Spin>
      </Layout.Content>

      {createOrder && (
        <CreateReturnModal
          order={createOrder}
          open
          onClose={() => setCreateOrder(null)}
          onCreated={refreshAll}
        />
      )}
    </Layout>
  );
}
