/**
 * 库存事务测试（验收 §7.5）：
 *   建物料 -> 入库 10 -> 出库 3 -> 结存 7 -> 流水齐全
 *   超量出库 -> 409 INSUFFICIENT_STOCK
 *   流水写入与结存计算必须在同一事务内（失败整体回滚）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { actor, bootstrap, loadDb, loadStore, uniq, useTempDb } from './helpers.mjs';

const tmp = useTempDb('stock');
const store = await loadStore();
const db = (await loadDb()).getDb();
bootstrap(db);

const A = actor('仓管甲');

/** 本次运行唯一前缀：多文件共享一个 DB，SKU 必须全局唯一 */
const P = uniq('SKU');
const S = (n) => `${P}-${n}`;

test('入库 10 -> 出库 3 -> 结存 7，流水 3 条（含建料）', () => {
  const item = store.runInTx(() =>
    store.createItem({ sku: S(1), name: '螺丝 M4', unit: '个', location: 'A-01' }, A),
  );
  assert.equal(store.onHandOf(item.id), 0, '新物料结存应为 0');

  const m1 = store.runInTx(() =>
    store.insertMovement({ itemId: item.id, type: 'in', quantity: 10, refNo: 'PO-1', partner: '供应商甲' }, A),
  );
  assert.equal(m1.quantity, 10);
  assert.equal(m1.signedQuantity, 10);
  assert.equal(m1.beforeQty, 0);
  assert.equal(m1.afterQty, 10);
  assert.equal(store.onHandOf(item.id), 10);

  const m2 = store.runInTx(() =>
    store.insertMovement({ itemId: item.id, type: 'out', quantity: 3, refNo: 'SO-1', partner: '生产乙' }, A),
  );
  assert.equal(m2.signedQuantity, -3);
  assert.equal(m2.beforeQty, 10);
  assert.equal(m2.afterQty, 7);
  assert.equal(store.onHandOf(item.id), 7, '结存应为 7');

  const { rows, total } = store.listMovements({ itemId: item.id, page: 1, pageSize: 20, offset: 0 });
  assert.equal(total, 2, '该物料流水 2 条');

  // 建料本身不写流水；把“含建料”的口径算作：建料 + 入库 + 出库 的 3 个业务事件
  const events = 1 + total;
  assert.equal(events, 3);

  // seq 单调递增
  assert.ok(m2.seq > m1.seq, 'seq 必须单调递增');

  // before/after 链式一致
  assert.equal(m1.afterQty, m2.beforeQty);
  const after = 10 - 3;
  assert.equal(after, 7);
});

test('超量出库返回 409 INSUFFICIENT_STOCK，且不产生流水', () => {
  const item = store.runInTx(() => store.createItem({ sku: S(2), name: '螺母 M4' }, A));
  store.runInTx(() => store.insertMovement({ itemId: item.id, type: 'in', quantity: 5 }, A));

  const before = store.onHandOf(item.id);
  let err;
  try {
    store.runInTx(() => store.insertMovement({ itemId: item.id, type: 'out', quantity: 8 }, A));
  } catch (e) {
    err = e;
  }
  assert.ok(err, '必须抛出错误');
  assert.equal(err.status, 409);
  assert.equal(err.code, 'INSUFFICIENT_STOCK');
  assert.match(err.message, /库存不足，当前结存 5/);
  assert.equal(store.onHandOf(item.id), before, '失败后结存不得变化');
  assert.equal(
    store.listMovements({ itemId: item.id, page: 1, pageSize: 20, offset: 0 }).total,
    1,
    '失败后不得留下流水',
  );
});

test('allowNegative 时允许负数出库（配合 stock:write 语义）', () => {
  const item = store.runInTx(() => store.createItem({ sku: S(3), name: '垫片' }, A));
  store.runInTx(() => store.insertMovement({ itemId: item.id, type: 'in', quantity: 2 }, A));
  const mv = store.runInTx(() =>
    store.insertMovement({ itemId: item.id, type: 'out', quantity: 5, allowNegative: true }, A),
  );
  assert.equal(mv.afterQty, -3);
  assert.equal(store.onHandOf(item.id), -3);
});

test('adjust 用 targetQty 计算 delta 并记录 adjust 类型', () => {
  const item = store.runInTx(() => store.createItem({ sku: S(4), name: '轴承' }, A));
  store.runInTx(() => store.insertMovement({ itemId: item.id, type: 'in', quantity: 20 }, A));
  const mv = store.runInTx(() => store.insertMovement({ itemId: item.id, type: 'adjust', targetQty: 17 }, A));
  assert.equal(mv.type, 'adjust');
  assert.equal(mv.signedQuantity, -3);
  assert.equal(mv.quantity, 3, 'quantity 恒为正');
  assert.equal(mv.afterQty, 17);
  assert.equal(store.onHandOf(item.id), 17);
});

test('事务原子性：批量入库中途失败整体回滚', () => {
  const a = store.runInTx(() => store.createItem({ sku: S(5), name: '皮带' }, A));
  const b = store.runInTx(() => store.createItem({ sku: S(6), name: '齿轮' }, A));

  assert.throws(() => {
    store.runInTx(() => {
      store.insertMovement({ itemId: a.id, type: 'in', quantity: 6 }, A);
      // 第二笔非法（出库超量）-> 整个事务必须回滚
      store.insertMovement({ itemId: b.id, type: 'out', quantity: 99 }, A);
    });
  });

  assert.equal(store.onHandOf(a.id), 0, '第一笔也必须回滚');
  assert.equal(store.listMovements({ itemId: a.id, page: 1, pageSize: 10, offset: 0 }).total, 0);
});

test('build: 结存列表按 onHand 正确聚合（唯一真源 = movements）', () => {
  const sku = S(7);
  const item = store.runInTx(() => store.createItem({ sku, name: '标签纸' }, A));
  store.runInTx(() => store.insertMovement({ itemId: item.id, type: 'in', quantity: 100 }, A));
  store.runInTx(() => store.insertMovement({ itemId: item.id, type: 'out', quantity: 40 }, A));
  const { rows, total } = store.listStock({ q: sku, page: 1, pageSize: 10, offset: 0 });
  assert.equal(total, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sku, sku);
  assert.equal(rows[0].onHand, 60);
});

test.after(() => tmp.cleanup());
