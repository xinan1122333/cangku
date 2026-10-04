/**
 * 物料 / HTTP 契约 / 种子 测试：
 *   建物料、SKU 重复 -> 409、软删
 *   统一响应包装 {ok:true,data} / {ok:false,error}
 *   seed 幂等（已有的 admin 不重置密码）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { actor, bootstrap, loadDb, loadStore, uniq, useTempDb } from './helpers.mjs';

const tmp = useTempDb('items');
const store = await loadStore();
const db = (await loadDb()).getDb();
bootstrap(db);

const A = actor('建料员');

/** 本次运行的唯一前缀：多文件共享一个 DB，SKU/条码必须全局唯一 */
const P = uniq('IT');
const S = (n) => `${P}-${n}`;
const BC = (n) => `${P}-BC-${n}`;

test('建物料：默认单位/状态/结存，SKU 与条码唯一', () => {
  const item = store.runInTx(() =>
    store.createItem(
      { sku: S(100), name: '打印机色带', barcode: BC(100), unit: '盒', safetyStock: 5 },
      A,
    ),
  );
  assert.equal(item.sku, S(100));
  assert.equal(item.unit, '盒');
  assert.equal(item.status, 'active');
  assert.equal(item.safetyStock, 5);
  assert.equal(item.onHand, 0);
  assert.ok(item.id, '必须生成 UUID 主键');
  assert.ok(item.createdAt > 0);
});

test('SKU 重复 -> 409 DUPLICATE_SKU', () => {
  store.runInTx(() => store.createItem({ sku: S(200), name: '一号料' }, A));
  let err;
  try {
    store.runInTx(() => store.createItem({ sku: S(200), name: '二号料' }, A));
  } catch (e) {
    err = e;
  }
  assert.ok(err, '必须抛错');
  assert.equal(err.status, 409);
  assert.equal(err.code, 'DUPLICATE_SKU');
});

test('条码重复 -> 409 DUPLICATE_BARCODE', () => {
  store.runInTx(() => store.createItem({ sku: S(300), name: '三号料', barcode: BC(300) }, A));
  let err;
  try {
    store.runInTx(() => store.createItem({ sku: S(301), name: '四号料', barcode: BC(300) }, A));
  } catch (e) {
    err = e;
  }
  assert.equal(err.status, 409);
  assert.equal(err.code, 'DUPLICATE_BARCODE');
});

test('建料可带期初库存（同一事务内写 in 流水）', () => {
  const item = store.runInTx(() =>
    store.createItem({ sku: S(400), name: '五号料' }, A, { quantity: 25, unitCost: 1200 }),
  );
  assert.equal(item.onHand, 25);
  const mvs = store.listMovements({ itemId: item.id, page: 1, pageSize: 5, offset: 0 });
  assert.equal(mvs.total, 1);
  assert.equal(mvs.rows[0].type, 'in');
  assert.equal(mvs.rows[0].unitCost, 1200);
});

test('软删=停用：不物理删除，流水仍在', () => {
  const item = store.runInTx(() => store.createItem({ sku: S(500), name: '六号料' }, A));
  store.runInTx(() => store.insertMovement({ itemId: item.id, type: 'in', quantity: 9 }, A));
  const disabled = store.runInTx(() => store.disableItem(item.id, A));
  assert.equal(disabled.status, 'disabled');

  const found = store.getItem(item.id);
  assert.ok(found, '记录必须还在');
  assert.equal(store.onHandOf(item.id), 9, '结存保留');

  // 停用后不可登记出入库
  let err;
  try {
    store.runInTx(() => store.insertMovement({ itemId: item.id, type: 'in', quantity: 1 }, A));
  } catch (e) {
    err = e;
  }
  assert.equal(err.status, 409);
  assert.equal(err.code, 'INVALID_STATE');
});

test('PATCH 物料可改属性，SKU 冲突照样 409', () => {
  const a = store.runInTx(() => store.createItem({ sku: S(600), name: '七号料' }, A));
  store.runInTx(() => store.createItem({ sku: S(601), name: '八号料' }, A));
  const updated = store.runInTx(() => store.updateItem(a.id, { name: '七号料(改)' }, A));
  assert.equal(updated.name, '七号料(改)');

  let err;
  try {
    store.runInTx(() => store.updateItem(a.id, { sku: S(601) }, A));
  } catch (e) {
    err = e;
  }
  assert.equal(err.status, 409);
  assert.equal(err.code, 'DUPLICATE_SKU');
});

test('列表分页与搜索', () => {
  const page1 = store.listItems({ page: 1, pageSize: 3, offset: 0 });
  assert.equal(page1.rows.length, 3);
  assert.ok(page1.total >= 6);
  const page2 = store.listItems({ page: 2, pageSize: 3, offset: 3 });
  assert.notEqual(page1.rows[0].id, page2.rows[0].id, '翻页不能重复');

  const searched = store.listItems({ q: S(400), page: 1, pageSize: 10, offset: 0 });
  assert.equal(searched.total, 1);
  assert.equal(searched.rows[0].sku, S(400));
});

test('扫码解析：条码优先，其次 SKU；未知返回 null', () => {
  const byBarcode = store.resolveScanCode(BC(300));
  assert.equal(byBarcode.sku, S(300));
  const bySku = store.resolveScanCode(S(400));
  assert.equal(bySku.sku, S(400));
  assert.equal(store.resolveScanCode(`${P}-NOT-EXIST`), null);
});

test('审计日志：每次写操作都有留痕，且含操作人', () => {
  const logs = store.listAuditLogs({ entity: 'item', page: 1, pageSize: 50, offset: 0 });
  assert.ok(logs.total > 0, '必须有审计记录');
  const create = logs.rows.find((l) => l.action === 'item.create');
  assert.ok(create, '必须有 item.create 审计');
  assert.equal(create.actorName, '建料员');
  assert.ok(create.createdAt > 0);
});

test('低库存筛选 lowOnly', () => {
  store.runInTx(() => store.createItem({ sku: S(700), name: '九号料', safetyStock: 100 }, A));
  const low = store.listStock({ lowOnly: true, page: 1, pageSize: 50, offset: 0 });
  assert.ok(low.rows.length > 0, '应有低库存物料');
  assert.ok(
    low.rows.some((r) => r.sku === S(700)),
    '安全库存 100 / 结存 0 必须命中 lowOnly',
  );
  assert.ok(low.rows.every((r) => r.onHand <= r.safetyStock));
});

test.after(() => tmp.cleanup());
