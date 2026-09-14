import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.RETURNS_DB || join(__dirname, 'returns.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// ---- 故障注入开关（仅用于演示/测试事务回滚）----
// failNext.<entity> = 1 时，下一次对应写操作在「部分写入已发生、尚未提交」时抛错，
// 触发整个事务回滚。
export const faultInjection = {
  failNextCreate: false,
  failNextDispose: false,
  reset() {
    this.failNextCreate = false;
    this.failNextDispose = false;
  },
};

function count(table) {
  return db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
}

// ---- 种子数据：商品 + 两张原订单 ----
export function seed() {
  if (count('products') > 0) return;
  const now = new Date().toISOString();
  const insP = db.prepare('INSERT INTO products (sku,name,price_cents) VALUES (?,?,?)');
  const p1 = insP.run('SKU-KEYBOARD', '机械键盘', 39900).lastInsertRowid; // 399.00
  const p2 = insP.run('SKU-MOUSE', '无线鼠标', 12900).lastInsertRowid;   // 129.00
  const p3 = insP.run('SKU-MONITOR', '27寸显示器', 189900).lastInsertRowid;// 1899.00

  const insO = db.prepare('INSERT INTO orders (order_no,customer,created_at) VALUES (?,?,?)');
  const o1 = insO.run('SO-1001', '张三', now).lastInsertRowid;
  const o2 = insO.run('SO-1002', '李四', now).lastInsertRowid;

  const insOI = db.prepare(
    'INSERT INTO order_items (order_id,product_id,qty,unit_price_cents) VALUES (?,?,?,?)'
  );
  // 订单1：键盘 x2，鼠标 x5
  insOI.run(o1, p1, 2, 39900);
  insOI.run(o1, p2, 5, 12900);
  // 订单2：显示器 x1（高单价，便于触发主管复核）
  insOI.run(o2, p3, 1, 189900);
}
seed();

// 高金额退款阈值（分）：达到/超过需主管复核。默认 1000.00 元。
export const REFUND_REVIEW_THRESHOLD_CENTS = Number(
  process.env.REFUND_REVIEW_THRESHOLD_CENTS || 100000
);

// 退款策略：返库=全额退；维修=按 30% 退；报废=不退
export const REFUND_RULES = {
  restockRate: 1.0,
  repairRate: 0.3,
  scrapRate: 0.0,
};
