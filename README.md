# 退货质检与处置台

围绕「客服建退货单 → 仓库签收/扫码/质检 → 处置算退款 → 主管复核关闭」的全链路控制台。
所有规则在服务端强校验，前端只做引导；每次写入都是数据库事务，失败整体回滚并留审计。

## 技术栈

- 前端：React 19 + TypeScript + Vite + Ant Design
- 后端：Node.js + Express + better-sqlite3（同步事务）
- 存储：SQLite 单文件（`server/returns.db`），刷新/重启后数据完整恢复
- 测试：Playwright 真实 Chromium 端到端

## 快速开始

```bash
npm install
npm run build          # 构建前端到 dist/
npm start              # 启动后端（默认 4000 端口），同时托管 dist/
# 打开 http://localhost:4000
```

开发模式（前端热更新，`/api` 代理到 4000）：

```bash
npm run server   # 终端1：后端 4000
npm run dev      # 终端2：Vite 5173
```

端口与阈值可用环境变量调整：`PORT`、`RETURNS_DB`、`REFUND_REVIEW_THRESHOLD_CENTS`（默认 100000=¥1000）。

## 角色与权限

顶部切换身份（请求头 `X-Role` / `X-Actor`，便于演示与测试）：

| 角色 | 权限 |
| --- | --- |
| 客服 agent | 按原订单选商品/数量建退货单 |
| 仓库 warehouse | 签收、扫码、质检分摊、处置 |
| 主管 supervisor | 高金额复核、关闭（也可处置） |

越权调用直接 `403 FORBIDDEN` 拒绝。

## 业务规则

1. **建单**：客服按原订单选择商品和数量。
   - 累计退货量（含已关闭历史）不得超过购买量，否则 `409 OVER_PURCHASED`。
   - 同一商品若存在未关闭（在途）退货单，不能重复申请，否则 `409 IN_TRANSIT_DUP`。
   - 提交带 `Idempotency-Key`，重复点击/并发重放/失败重试都只产生一张单。
2. **状态机**：`booked 已预约 → signed 已签收 → inspected 已质检 → disposed 已处置 → closed 已关闭`。
   任何跳步（如未签收先质检）返回 `409 INVALID_STEP`，UI 也只暴露当前可用动作。
3. **扫码**：仅在「已签收、未质检」阶段可逐件扫码。
   - 同一序列号只记一次（重复扫码幂等忽略、不增加实收）。
   - 每个商品的**实收数量不得超过申请退货量**，超出的扫码在事务内回滚并返回 `409 SCAN_EXCEEDS_REQUESTED`。
   - 质检完成后扫码窗口关闭：再扫码返回 `409 INVALID_STEP`，实收/分摊/退款不再被改变。
4. **质检**：每个商品的实收数量必须**完整分摊**到 返库/维修/报废，三类合计恰好等于实收，否则 `409 ALLOCATION_MISMATCH`。
5. **处置与退款**：退款 = 单价 ×（返库×100% + 维修×30% + 报废×0%）。
   退款合计达到阈值（默认 ¥1000）标记为高金额，必须主管复核通过后才能关闭，否则 `409 PENDING_REVIEW`。
6. **事务与审计**：每个写操作在单个 SQLite 事务内完成；任一写入失败，状态、数量、退款、审计一起回滚。
   成功流转写 `audits` 成功记录；越权/跳步等拒绝事件即使回滚也单独补记 `denied` 留痕。
7. **恢复**：状态全部落在 SQLite，刷新页面或重启服务后从接口完整恢复。
8. **生产安全**：`/api/test/reset`、`/api/test/fault` 等测试入口**仅在非生产环境注册**；
   `npm start` 以 `NODE_ENV=production` 运行，这些路由返回 404，无法在无认证情况下清空数据或注入故障。
   开发/演示用 `npm run server`（非生产）保留这些入口。

## 失败回滚演示（故障注入）

需用**非生产**服务（`npm run server`，不要用 `NODE_ENV=production` 的 `npm start`）。
`POST /api/test/fault { "failNextCreate": true }` 或 `{ "failNextDispose": true }`，
会让**下一次**建单/处置在事务内、提交前抛错（标志一次性，自动清除），可观察到：
退货单/商品行/处置明细/退款/审计均未产生，状态停留在上一步，随后用相同幂等键可正常重试。

## API 摘要

- `GET /api/orders` 原订单（含每行购买量、累计已退、在途量）
- `GET/POST /api/returns`；`POST /api/returns/:id/{sign,scan,inspect,dispose,review,close}`
- `GET /api/audits`、`GET /api/config`
- 测试辅助：`POST /api/test/reset`、`POST /api/test/fault`

## 测试

真实 Chromium 端到端，覆盖：正常全流程、累计超量、在途重复、幂等重复提交、双击、越权、跳步、
分摊不平、高金额复核、建单/处置失败回滚、刷新恢复。

```bash
npm test
```

Playwright 会用独立数据库 `server/e2e.db` 并在 4100 端口自启服务，每个用例前自动重置数据。

> 在非 root、无法 `npx playwright install-deps` 的容器里，先执行
> `scripts/setup-syslib.sh`（用 `apt-get download` 免 root 解包 Chromium 依赖到 `.syslib/`），
> `npm test` 的启动器会自动把这些库加入 `LD_LIBRARY_PATH`。

## 目录

```
server/            Express + better-sqlite3 后端
  schema.sql       关系模型
  db.js            连接、pragma、种子数据、退款阈值/规则
  services.js      事务、状态机、权限、分摊、退款、审计、故障注入
  index.js         路由 + 静态托管
src/               React 前端（App / api / components）
tests/             Playwright 端到端（01 正常流程 … 04 回滚恢复）
scripts/           冒烟脚本、回滚校验、测试启动器、系统库准备
```
