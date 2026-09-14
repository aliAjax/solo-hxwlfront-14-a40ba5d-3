import { db, faultInjection, REFUND_REVIEW_THRESHOLD_CENTS, REFUND_RULES } from './db.js';

// 角色与权限
export const ROLES = {
  agent: 'agent',           // 客服：只能建退货单
  warehouse: 'warehouse',   // 仓库：预约/签收/质检/处置
  supervisor: 'supervisor', // 主管：高金额复核 + 关闭
};

// 每个流转动作：所需当前状态 -> 目标状态，允许的角色
const TRANSITIONS = {
  book:     { from: null,       to: 'booked',    roles: [ROLES.agent] },      // 建单即已预约
  sign:     { from: 'booked',   to: 'signed',    roles: [ROLES.warehouse] },
  inspect:  { from: 'signed',   to: 'inspected', roles: [ROLES.warehouse] },
  dispose:  { from: 'inspected',to: 'disposed',  roles: [ROLES.warehouse, ROLES.supervisor] },
  close:    { from: 'disposed', to: 'closed',    roles: [ROLES.supervisor] },
};

// 业务错误：带 HTTP 状态码；拒绝类（越权/跳步/校验）记为 denied
export class BizError extends Error {
  constructor(status, code, message, rollbackAudit = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.rollbackAudit = rollbackAudit; // 事务回滚后需要补记的「拒绝」审计
  }
}

const nowIso = () => new Date().toISOString();
let seq = 0;
function genNo(prefix) {
  seq = (seq + 1) % 1000;
  const t = Date.now().toString(36);
  return `${prefix}-${t}${seq.toString().padStart(3, '0')}`;
}

// 在事务内写成功审计
function auditSuccess(returnOrderId, actor, action, detail) {
  db.prepare(
    'INSERT INTO audits (return_order_id, actor, action, detail, result, created_at) VALUES (?,?,?,?,?,?)'
  ).run(returnOrderId, actor, action, JSON.stringify(detail), 'success', nowIso());
}

/* ------------------------------------------------------------------ *
 * 建退货单（客服）
 *  - 幂等键防重复提交
 *  - 累计退货量（所有非关闭/或全部？见下）不得超过购买量
 *  - 同一在途（未关闭）商品不可重复申请
 * ------------------------------------------------------------------ */
export function createReturn({ actor, role, orderId, items, idempotencyKey }) {
  if (role !== ROLES.agent) {
    throw new BizError(403, 'FORBIDDEN', '只有客服可以创建退货单', {
      actor, action: 'create', detail: { reason: 'role', role },
    });
  }
  if (!idempotencyKey) throw new BizError(400, 'BAD_REQUEST', '缺少幂等键 Idempotency-Key');

  // 幂等：命中已完成请求则原样返回
  const existing = db.prepare('SELECT response FROM idempotency WHERE idempotency_key=?').get(idempotencyKey);
  if (existing) return JSON.parse(existing.response);

  if (!Array.isArray(items) || items.length === 0)
    throw new BizError(400, 'VALIDATION', '至少选择一个退货商品');

  const normalized = {};
  for (const it of items) {
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty <= 0)
      throw new BizError(400, 'VALIDATION', '退货数量必须为正整数');
    if (normalized[it.orderItemId])
      throw new BizError(400, 'VALIDATION', '同一商品在一张退货单中只能出现一次');
    normalized[it.orderItemId] = qty;
  }

  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) throw new BizError(404, 'NOT_FOUND', '原订单不存在');

  // 事务：所有校验与写入原子提交，失败整体回滚
  const result = db.transaction(() => {
    const tx = db;
    const returnNo = genNo('RT');
    const ts = nowIso();

    const roId = tx
      .prepare(
        `INSERT INTO return_orders (return_no, order_id, status, created_by, current_step_by, created_at, updated_at)
         VALUES (?,?, 'booked', ?, ?, ?, ?)`
      )
      .run(returnNo, orderId, actor, actor, ts, ts).lastInsertRowid;

    for (const [orderItemIdStr, qty] of Object.entries(normalized)) {
      const orderItemId = Number(orderItemIdStr);
      const oi = tx
        .prepare('SELECT * FROM order_items WHERE id=? AND order_id=?')
        .get(orderItemId, orderId);
      if (!oi) throw new BizError(400, 'VALIDATION', '商品不属于所选原订单');

      // 同一在途（状态非 closed）商品不可重复申请
      const inTransit = tx
        .prepare(
          `SELECT ro.id, ro.status, ri.qty
             FROM return_items ri
             JOIN return_orders ro ON ro.id = ri.return_order_id
            WHERE ri.order_item_id=? AND ro.status != 'closed'`
        )
        .all(orderItemId);
      if (inTransit.length > 0) {
        throw new BizError(
          409,
          'IN_TRANSIT_DUP',
          '该商品已有在途退货单，不能重复申请',
          { actor, action: 'create', detail: { orderItemId, existing: inTransit[0].id } }
        );
      }

      // 累计退货量（含已关闭）不得超过购买量
      const agg = tx
        .prepare('SELECT COALESCE(SUM(qty),0) total FROM return_items WHERE order_item_id=?')
        .get(orderItemId).total;
      if (agg + qty > oi.qty) {
        throw new BizError(
          409,
          'OVER_PURCHASED',
          `累计退货量 ${agg + qty} 超过购买量 ${oi.qty}`,
          { actor, action: 'create', detail: { orderItemId, purchased: oi.qty, alreadyReturned: agg, requested: qty } }
        );
      }

      tx.prepare(
        `INSERT INTO return_items (return_order_id, order_item_id, product_id, qty)
         VALUES (?,?,?,?)`
      ).run(roId, orderItemId, oi.product_id, qty);
    }

    auditSuccess( roId, actor, 'create', { returnNo, orderId, items: normalized });

    // —— 故障注入：模拟「写到一半」失败，前面的插入必须全部回滚 ——
    if (faultInjection.failNextCreate) {
      faultInjection.failNextCreate = false;
      throw new BizError(500, 'INJECTED_FAILURE', '（故障注入）建单写入失败，触发回滚');
    }

    return getReturnDetail(roId);
  })();

  db.prepare('INSERT INTO idempotency (idempotency_key, response, created_at) VALUES (?,?,?)')
    .run(idempotencyKey, JSON.stringify(result), nowIso());
  return result;
}

/* ------------------------------------------------------------------ *
 * 通用状态流转守卫：角色 + 状态（跳步直接拒绝）
 * ------------------------------------------------------------------ */
function guard(returnOrderId, action, actor, role) {
  const rule = TRANSITIONS[action];
  if (!rule) throw new BizError(400, 'BAD_REQUEST', `未知动作 ${action}`);
  if (!rule.roles.includes(role)) {
    throw new BizError(403, 'FORBIDDEN', `角色 ${role} 无权执行「${action}」`, {
      actor, action, detail: { reason: 'role', role, status: null },
    });
  }
  const ro = db.prepare('SELECT * FROM return_orders WHERE id=?').get(returnOrderId);
  if (!ro) throw new BizError(404, 'NOT_FOUND', '退货单不存在');
  if (ro.status !== rule.from) {
    throw new BizError(
      409,
      'INVALID_STEP',
      `不能从「${ro.status}」执行「${action}」（需处于 ${rule.from}）`,
      { actor, action, detail: { reason: 'step', current: ro.status, expected: rule.from } }
    );
  }
  return ro;
}

function transitionStatus(tx, roId, from, to, actor) {
  const r = tx
    .prepare('UPDATE return_orders SET status=?, current_step_by=?, updated_at=? WHERE id=? AND status=?')
    .run(to, actor, nowIso(), roId, from);
  if (r.changes !== 1) throw new BizError(409, 'INVALID_STEP', '状态已变化，请刷新后重试');
}

/* ------------------------------------------------------------------ *
 * 预约（booked 已是建单后的初始态，提供显式 confirm 通道以备补录）
 * 这里 sign=签收，是包裹到达仓库的流转；签收本身不要求扫码。
 * ------------------------------------------------------------------ */
export function signReturn({ id, actor, role }) {
  guard(id, 'sign', actor, role);
  db.transaction(() => {
    transitionStatus(db, id, 'booked', 'signed', actor);
    auditSuccess( id, actor, 'sign', {});
  })();
  return getReturnDetail(id);
}

/* ------------------------------------------------------------------ *
 * 扫码（签收后可随时扫，归在 signed 阶段累积实收）
 * 重复扫码只记一次。
 * ------------------------------------------------------------------ */
export function scanItem({ id, actor, role, productId, scanCode }) {
  if (role !== ROLES.warehouse) {
    throw new BizError(403, 'FORBIDDEN', '只有仓库人员可以扫码', {
      actor, action: 'scan', detail: { reason: 'role', role },
    });
  }
  const ro = db.prepare('SELECT * FROM return_orders WHERE id=?').get(id);
  if (!ro) throw new BizError(404, 'NOT_FOUND', '退货单不存在');
  if (ro.status !== 'signed' && ro.status !== 'inspected') {
    // 扫码只允许在签收之后、质检完成前后的实收阶段；预约/处置后不允许
    throw new BizError(409, 'INVALID_STEP', '当前状态不允许扫码（需先签收）', {
      actor, action: 'scan', detail: { reason: 'step', current: ro.status },
    });
  }
  const code = String(scanCode || '').trim();
  if (!code) throw new BizError(400, 'VALIDATION', '扫码序列号不能为空');

  const item = db
    .prepare('SELECT * FROM return_items WHERE return_order_id=? AND product_id=?')
    .get(id, productId);
  if (!item) throw new BizError(400, 'VALIDATION', '该商品不在此退货单中');

  let duplicate = false;
  db.transaction(() => {
    try {
      db.prepare(
        'INSERT INTO scans (return_order_id, product_id, scan_code, scanned_by, scanned_at) VALUES (?,?,?,?,?)'
      ).run(id, productId, code, actor, nowIso());
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        duplicate = true;
        return; // 重复扫码：幂等忽略，只记一次
      }
      throw e;
    }
    db.prepare('UPDATE return_items SET received_qty = received_qty + 1 WHERE id=?').run(item.id);
    auditSuccess( id, actor, 'scan', { productId, scanCode: code });
  })();

  return { ...getReturnDetail(id), duplicate };
}

/* ------------------------------------------------------------------ *
 * 质检：把每个商品的「实收数量」完整分摊到 返库/维修/报废
 * 三类之和必须恰好等于实收数量。
 * ------------------------------------------------------------------ */
export function inspectReturn({ id, actor, role, allocations }) {
  guard(id, 'inspect', actor, role);
  const ro = db.prepare('SELECT * FROM return_orders WHERE id=?').get(id);
  const items = db.prepare('SELECT * FROM return_items WHERE return_order_id=?').all(id);

  if (!Array.isArray(allocations)) throw new BizError(400, 'VALIDATION', '缺少分摊数据');
  const byProduct = {};
  for (const a of allocations) {
    byProduct[a.productId] = {
      restock: Number(a.restockQty) || 0,
      repair: Number(a.repairQty) || 0,
      scrap: Number(a.scrapQty) || 0,
    };
  }

  db.transaction(() => {
    for (const it of items) {
      if (it.received_qty <= 0)
        throw new BizError(409, 'NOT_RECEIVED', `商品 ${it.product_id} 尚无实收扫码，不能质检`);
      const a = byProduct[it.product_id];
      if (!a) throw new BizError(400, 'VALIDATION', `缺少商品 ${it.product_id} 的质检分摊`);
      for (const v of [a.restock, a.repair, a.scrap])
        if (!Number.isInteger(v) || v < 0)
          throw new BizError(400, 'VALIDATION', '分摊数量必须为非负整数');
      const sum = a.restock + a.repair + a.scrap;
      if (sum !== it.received_qty) {
        throw new BizError(
          409,
          'ALLOCATION_MISMATCH',
          `商品 ${it.product_id} 分摊合计 ${sum} 必须恰好等于实收数量 ${it.received_qty}`
        );
      }
      db.prepare(
        `UPDATE return_items
            SET restock_qty=?, repair_qty=?, scrap_qty=?
          WHERE id=?`
      ).run(a.restock, a.repair, a.scrap, it.id);
    }
    transitionStatus(db, id, 'signed', 'inspected', actor);
    auditSuccess( id, actor, 'inspect', { allocations: byProduct });
  })();
  return getReturnDetail(id);
}

// 计算单件商品退款（分）
function itemRefund(unitPriceCents, a) {
  return Math.round(
    unitPriceCents *
      (a.restock * REFUND_RULES.restockRate +
        a.repair * REFUND_RULES.repairRate +
        a.scrap * REFUND_RULES.scrapRate)
  );
}

/* ------------------------------------------------------------------ *
 * 处置：写入处置明细 + 计算退款；高金额需主管复核（review）。
 * 任一写入失败 -> 状态、数量、退款、审计整体回滚（故障注入演示）。
 * ------------------------------------------------------------------ */
export function disposeReturn({ id, actor, role }) {
  guard(id, 'dispose', actor, role);
  const ro = db.prepare('SELECT * FROM return_orders WHERE id=?').get(id);
  const items = db
    .prepare(
      `SELECT ri.*, oi.unit_price_cents
         FROM return_items ri
         JOIN order_items oi ON oi.id = ri.order_item_id
        WHERE ri.return_order_id=?`
    )
    .all(id);

  let result;
  db.transaction(() => {
    let total = 0;
    for (const it of items) {
      const refund = itemRefund(it.unit_price_cents, {
        restock: it.restock_qty, repair: it.repair_qty, scrap: it.scrap_qty,
      });
      total += refund;
      db.prepare(
        `INSERT INTO dispositions (return_order_id, product_id, restock_qty, repair_qty, scrap_qty, refund_cents)
         VALUES (?,?,?,?,?,?)`
      ).run(id, it.product_id, it.restock_qty, it.repair_qty, it.scrap_qty, refund);
      db.prepare('UPDATE return_items SET refund_cents=? WHERE id=?').run(refund, it.id);
    }

    const needs = total >= REFUND_REVIEW_THRESHOLD_CENTS ? 1 : 0;
    db.prepare(
      `INSERT INTO refunds (return_order_id, total_cents, status, created_at)
       VALUES (?,?, 'computed', ?)`
    ).run(id, total, nowIso());
    db.prepare(
      `UPDATE return_orders
          SET refund_total_cents=?, needs_supervisor=?, updated_at=?
        WHERE id=?`
    ).run(total, needs, nowIso(), id);

    transitionStatus(db, id, 'inspected', 'disposed', actor);
    auditSuccess( id, actor, 'dispose', { totalCents: total, needsSupervisor: !!needs });

    // —— 故障注入：处置明细/退款/状态/审计都已写入但尚未提交，此刻失败必须全部回滚 ——
    if (faultInjection.failNextDispose) {
      faultInjection.failNextDispose = false;
      throw new BizError(500, 'INJECTED_FAILURE', '（故障注入）处置写入失败，触发回滚');
    }
    result = getReturnDetail(id);
  })();
  return result;
}

/* ------------------------------------------------------------------ *
 * 主管复核：仅高金额退款单需要；通过后退款置 approved。
 * ------------------------------------------------------------------ */
export function reviewReturn({ id, actor, role, decision }) {
  if (role !== ROLES.supervisor)
    throw new BizError(403, 'FORBIDDEN', '只有主管可以复核退款', {
      actor, action: 'review', detail: { reason: 'role', role },
    });
  const ro = db.prepare('SELECT * FROM return_orders WHERE id=?').get(id);
  if (!ro) throw new BizError(404, 'NOT_FOUND', '退货单不存在');
  if (ro.status !== 'disposed')
    throw new BizError(409, 'INVALID_STEP', '仅已处置的退货单可复核', {
      actor, action: 'review', detail: { reason: 'step', current: ro.status },
    });
  if (!ro.needs_supervisor)
    throw new BizError(409, 'REVIEW_NOT_REQUIRED', '该退货单退款未达复核阈值，无需复核');

  db.transaction(() => {
    const status = decision === 'approved' ? 'approved' : 'rejected';
    db.prepare('UPDATE refunds SET status=?, reviewed_by=?, reviewed_at=? WHERE return_order_id=?')
      .run(status, actor, nowIso(), id);
    db.prepare('UPDATE return_orders SET approved_by=?, updated_at=? WHERE id=?')
      .run(actor, nowIso(), id);
    auditSuccess( id, actor, 'review', { decision: status });
  })();
  return getReturnDetail(id);
}

/* ------------------------------------------------------------------ *
 * 关闭：仅主管；若需复核而未复核通过则拒绝。
 * ------------------------------------------------------------------ */
export function closeReturn({ id, actor, role }) {
  guard(id, 'close', actor, role);
  const ro = db.prepare('SELECT * FROM return_orders WHERE id=?').get(id);
  if (ro.needs_supervisor) {
    const refund = db.prepare('SELECT * FROM refunds WHERE return_order_id=?').get(id);
    if (!refund || refund.status !== 'approved') {
      throw new BizError(
        409,
        'PENDING_REVIEW',
        '高金额退款尚未经主管复核通过，不能关闭',
        { actor, action: 'close', detail: { reason: 'review', refundStatus: refund ? refund.status : null } }
      );
    }
  }
  db.transaction(() => {
    transitionStatus(db, id, 'disposed', 'closed', actor);
    auditSuccess( id, actor, 'close', {});
  })();
  return getReturnDetail(id);
}

/* ------------------------------------------------------------------ *
 * 查询：退货单详情（含商品行、扫码、处置、退款）——刷新恢复的依据
 * ------------------------------------------------------------------ */
export function getReturnDetail(id) {
  const ro = db.prepare('SELECT * FROM return_orders WHERE id=?').get(id);
  if (!ro) throw new BizError(404, 'NOT_FOUND', '退货单不存在');
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(ro.order_id);
  const items = db
    .prepare(
      `SELECT ri.*, p.sku, p.name, oi.unit_price_cents, oi.qty AS purchased_qty
         FROM return_items ri
         JOIN products p ON p.id = ri.product_id
         JOIN order_items oi ON oi.id = ri.order_item_id
        WHERE ri.return_order_id=?`
    )
    .all(id);
  const scans = db.prepare('SELECT * FROM scans WHERE return_order_id=? ORDER BY id').all(id);
  const dispositions = db.prepare('SELECT * FROM dispositions WHERE return_order_id=?').all(id);
  const refund = db.prepare('SELECT * FROM refunds WHERE return_order_id=?').get(id) || null;
  return { ...ro, order, items, scans, dispositions, refund };
}
