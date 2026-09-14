import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { db, faultInjection, REFUND_REVIEW_THRESHOLD_CENTS, seed } from './db.js';
import {
  BizError, createReturn, signReturn, scanItem, inspectReturn,
  disposeReturn, reviewReturn, closeReturn, getReturnDetail,
} from './services.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// 从请求头解析当前操作人：X-Actor（工号）与 X-Role（角色）
function identity(req, res, next) {
  req.actor = String(req.get('X-Actor') || 'anonymous');
  req.role = String(req.get('X-Role') || '');
  next();
}
app.use(identity);

// 统一错误处理：BizError 回滚后，拒绝事件也要留痕（审计与事务解耦）
function handle(fn) {
  return (req, res) => {
    try {
      const data = fn(req, res);
      if (!res.headersSent) res.json({ ok: true, data });
    } catch (e) {
      if (e instanceof BizError) {
        if (e.rollbackAudit) {
          const a = e.rollbackAudit;
          try {
            db.prepare(
              'INSERT INTO audits (return_order_id, actor, action, detail, result, created_at) VALUES (?,?,?,?,?,?)'
            ).run(null, a.actor, a.action, JSON.stringify(a.detail), 'denied', new Date().toISOString());
          } catch { /* ignore audit failure */ }
        }
        return res.status(e.status).json({ ok: false, error: { code: e.code, message: e.message } });
      }
      console.error(e);
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  };
}

// ---- 基础数据 ----
app.get('/api/orders', handle((req) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY id').all();
  return orders.map((o) => ({
    ...o,
    items: db
      .prepare(
        `SELECT oi.*, p.sku, p.name,
                (SELECT COALESCE(SUM(qty),0) FROM return_items ri
                   JOIN return_orders ro ON ro.id=ri.return_order_id
                  WHERE ri.order_item_id=oi.id AND ro.status!='closed') AS in_transit_qty,
                (SELECT COALESCE(SUM(qty),0) FROM return_items ri
                  WHERE ri.order_item_id=oi.id) AS returned_qty
           FROM order_items oi JOIN products p ON p.id=oi.product_id
          WHERE oi.order_id=?`
      )
      .all(o.id),
  }));
}));

app.get('/api/returns', handle(() =>
  db.prepare('SELECT * FROM return_orders ORDER BY id DESC').all()
));

app.get('/api/returns/:id', handle((req) => getReturnDetail(Number(req.params.id))));

// ---- 建退货单（幂等）----
app.post('/api/returns', handle((req) =>
  createReturn({
    actor: req.actor,
    role: req.role,
    orderId: Number(req.body.orderId),
    items: req.body.items,
    idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey,
  })
));

// ---- 流转动作 ----
app.post('/api/returns/:id/sign', handle((req) =>
  signReturn({ id: Number(req.params.id), actor: req.actor, role: req.role })));

app.post('/api/returns/:id/scan', handle((req) =>
  scanItem({
    id: Number(req.params.id), actor: req.actor, role: req.role,
    productId: Number(req.body.productId), scanCode: req.body.scanCode,
  })));

app.post('/api/returns/:id/inspect', handle((req) =>
  inspectReturn({
    id: Number(req.params.id), actor: req.actor, role: req.role,
    allocations: req.body.allocations,
  })));

app.post('/api/returns/:id/dispose', handle((req) =>
  disposeReturn({ id: Number(req.params.id), actor: req.actor, role: req.role })));

app.post('/api/returns/:id/review', handle((req) =>
  reviewReturn({
    id: Number(req.params.id), actor: req.actor, role: req.role,
    decision: req.body.decision || 'approved',
  })));

app.post('/api/returns/:id/close', handle((req) =>
  closeReturn({ id: Number(req.params.id), actor: req.actor, role: req.role })));

app.get('/api/audits', handle((req) =>
  db.prepare('SELECT * FROM audits WHERE (? IS NULL OR return_order_id=?) ORDER BY id DESC LIMIT 300')
    .all(req.query.returnId ? Number(req.query.returnId) : null, req.query.returnId ? Number(req.query.returnId) : null)
));

app.get('/api/config', handle(() => ({
  refundReviewThresholdCents: REFUND_REVIEW_THRESHOLD_CENTS,
})));

// ---- 故障注入（仅演示/测试用）----
app.post('/api/test/fault', handle((req) => {
  faultInjection.failNextCreate = !!req.body.failNextCreate;
  faultInjection.failNextDispose = !!req.body.failNextDispose;
  return { failNextCreate: faultInjection.failNextCreate, failNextDispose: faultInjection.failNextDispose };
}));

// 测试辅助：重置数据库（删除文件由外部脚本完成；这里仅清空业务表并重新种子）
app.post('/api/test/reset', handle((req) => {
  db.transaction(() => {
    for (const t of [
      'audits', 'refunds', 'dispositions', 'scans', 'return_items',
      'return_orders', 'idempotency', 'order_items', 'orders', 'products',
    ]) db.prepare(`DELETE FROM ${t}`).run();
    faultInjection.reset();
  })();
  seed();
  return { reset: true };
}));

// ---- 生产静态资源 ----
const distDir = join(__dirname, '..', 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(distDir, 'index.html')));
}

const PORT = process.env.PORT || 4000;
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`退货质检与处置台后端: http://localhost:${PORT}`));
}
export default app;
