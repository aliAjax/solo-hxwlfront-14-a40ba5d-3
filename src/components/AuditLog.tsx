import { Table, Tag } from "antd";
import type { AuditRow } from "../api";

const COLOR: Record<string, string> = {
  success: "green",
  denied: "red",
  failed: "volcano",
};
const ACTION_LABEL: Record<string, string> = {
  create: "建单", sign: "签收", scan: "扫码", inspect: "质检",
  dispose: "处置", review: "复核", close: "关闭",
};

export default function AuditLog({ rows }: { rows: AuditRow[] }) {
  return (
    <Table
      rowKey="id"
      size="small"
      dataSource={rows}
      pagination={{ pageSize: 8 }}
      columns={[
        { title: "时间", dataIndex: "created_at", width: 200, render: (v: string) => new Date(v).toLocaleString() },
        { title: "操作人", dataIndex: "actor", width: 90 },
        { title: "动作", dataIndex: "action", width: 80, render: (v: string) => ACTION_LABEL[v] || v },
        {
          title: "结果", dataIndex: "result", width: 90,
          render: (v: string) => <Tag color={COLOR[v] || "default"}>{v}</Tag>,
        },
        { title: "明细", dataIndex: "detail", render: (v: string) => <code style={{ fontSize: 12 }}>{v}</code> },
      ]}
    />
  );
}
