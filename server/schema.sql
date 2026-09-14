-- 退货质检与处置台：关系模型
-- 所有金额以「分」存储，避免浮点误差。

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY,
  sku         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  price_cents INTEGER NOT NULL           -- 商品单价（分）
);

CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY,
  order_no    TEXT NOT NULL UNIQUE,
  customer    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty        INTEGER NOT NULL,           -- 购买数量
  unit_price_cents INTEGER NOT NULL,     -- 成交单价（分）
  UNIQUE(order_id, product_id)
);

-- 退货单（包裹），严格状态机：
-- booked(已预约) -> signed(已签收) -> inspected(已质检) -> disposed(已处置) -> closed(已关闭)
CREATE TABLE IF NOT EXISTS return_orders (
  id            INTEGER PRIMARY KEY,
  return_no     TEXT NOT NULL UNIQUE,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  status        TEXT NOT NULL DEFAULT 'booked',
  created_by    TEXT NOT NULL,           -- 客服工号
  current_step_by TEXT,                  -- 最近一次流转操作人
  refund_total_cents INTEGER NOT NULL DEFAULT 0,
  needs_supervisor INTEGER NOT NULL DEFAULT 0,  -- 高金额，需主管复核
  approved_by   TEXT,                    -- 主管复核工号
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS return_items (
  id              INTEGER PRIMARY KEY,
  return_order_id INTEGER NOT NULL REFERENCES return_orders(id) ON DELETE CASCADE,
  order_item_id   INTEGER NOT NULL REFERENCES order_items(id),
  product_id      INTEGER NOT NULL REFERENCES products(id),
  qty             INTEGER NOT NULL,      -- 申请退货数量
  received_qty    INTEGER NOT NULL DEFAULT 0, -- 实收（去重扫码计数）
  restock_qty     INTEGER NOT NULL DEFAULT 0, -- 返库
  repair_qty      INTEGER NOT NULL DEFAULT 0, -- 维修
  scrap_qty       INTEGER NOT NULL DEFAULT 0, -- 报废
  refund_cents    INTEGER NOT NULL DEFAULT 0,
  UNIQUE(return_order_id, order_item_id)
);

-- 扫码记录：同一(退货单,商品,扫码序列号)只记一次
CREATE TABLE IF NOT EXISTS scans (
  id              INTEGER PRIMARY KEY,
  return_order_id INTEGER NOT NULL REFERENCES return_orders(id) ON DELETE CASCADE,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  scan_code       TEXT NOT NULL,
  scanned_by      TEXT NOT NULL,
  scanned_at      TEXT NOT NULL,
  UNIQUE(return_order_id, product_id, scan_code)
);

-- 处置结果明细（按商品）
CREATE TABLE IF NOT EXISTS dispositions (
  id              INTEGER PRIMARY KEY,
  return_order_id INTEGER NOT NULL REFERENCES return_orders(id) ON DELETE CASCADE,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  restock_qty     INTEGER NOT NULL,
  repair_qty      INTEGER NOT NULL,
  scrap_qty       INTEGER NOT NULL,
  refund_cents    INTEGER NOT NULL,
  UNIQUE(return_order_id, product_id)
);

-- 退款单
CREATE TABLE IF NOT EXISTS refunds (
  id              INTEGER PRIMARY KEY,
  return_order_id INTEGER NOT NULL UNIQUE REFERENCES return_orders(id) ON DELETE CASCADE,
  total_cents     INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'computed',  -- computed / approved / rejected
  reviewed_by     TEXT,
  reviewed_at     TEXT,
  created_at      TEXT NOT NULL
);

-- 审计日志：每一次成功的写操作 / 拒绝事件
CREATE TABLE IF NOT EXISTS audits (
  id              INTEGER PRIMARY KEY,
  return_order_id INTEGER,
  actor           TEXT NOT NULL,
  action          TEXT NOT NULL,
  detail          TEXT NOT NULL,
  result          TEXT NOT NULL,          -- success / denied / failed
  created_at      TEXT NOT NULL
);

-- 幂等键：客户端防重复提交
CREATE TABLE IF NOT EXISTS idempotency (
  idempotency_key TEXT PRIMARY KEY,
  response        TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
