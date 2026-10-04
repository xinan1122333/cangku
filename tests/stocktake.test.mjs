/**
 * 盘点测试（验收 §7.5）：
 *   建物料 -> 入库 -> 建盘点单（带快照 bookQty）-> 录入实盘 -> 过账
 *   过账后结存必须等于实盘数；重复过账被拒；差异为 0 不写流水。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { actor, bootstrap, loadDb, loadStore, uniq, useTempDb } from './helpers.mjs';

const tmp = useTempDb('stocktake');
const store = await loadStore();
const db = (await loadDb()).getDb();
bootstrap(db);

const A = actor('盘点员');

/** 本次运行唯一前缀：多文件共享一个 DB，标识符必须全局唯一 */
const P = uniq('PD');
const S = (n) => `${P}-${n}`;

test('盘点过账：结存被调整为实盘数，并留下 stocktake 流水', () => {
  const item = store.runInTx(() => store.createItem({ sku: S(1), name: '盘点物料A' }, A));
  store.runInTx(() => store.insertMovement({ itemId: item.id, type: 'in', quantity: 30 }, A));
  assert.equal(store.onHandOf(item.id), 30);

  // 建盘点单（带明细，系统快照 bookQty）
  const sheet = store.runInTx(() =>
    store.createStocktake(
      { location: 'A区', remark: '月末盘点', lines: [{ itemId: item.id }] },
      A,
    ),
  );
  assert.equal(sheet.status, 'draft');
  assert.equal(sheet.lines.length, 1);
  assert.equal(sheet.lines[0].bookQty, 30, 'bookQty 必须是台账结存快照');

  // 录入实盘 27（盘亏 3）
  const updated = store.runInTx(() =>
    store.updateStocktake(sheet.id, { lines: [{ itemId: item.id, countedQty: 27 }] }, A),
  );
  assert.equal(updated.status, 'counting');
  assert.equal(updated.lines[0].countedQty, 27);
  assert.equal(updated.lines[0].diffQty, -3);

  // 过账
  const posted = store.runInTx(() => store.postStocktake(sheet.id, A));
  assert.equal(posted.status, 'posted');
  assert.ok(posted.postedAt, 'postedAt 必须写入');
  assert.equal(store.onHandOf(item.id), 27, '过账后结存 = 实盘数');

  const movements = store.listMovements({
    itemId: item.id,
    type: 'stocktake',
    page: 1,
    pageSize: 10,
    offset: 0,
  });
  assert.equal(movements.total, 1, '盘亏生成 1 条 stocktake 流水');
  assert.equal(movements.rows[0].signedQuantity, -3);
  assert.equal(movements.rows[0].beforeQty, 30);
  assert.equal(movements.rows[0].afterQty, 27);
  assert.equal(movements.rows[0].refNo, sheet.code, '流水必须关联盘点单号');
});

test('重复过账被拒绝（409 INVALID_STATE），结存不再变化', () => {
  const item = store.runInTx(() => store.createItem({ sku: S(2), name: '盘点物料B' }, A));
  store.runInTx(() => store.insertMovement({ itemId: item.id, type: 'in', quantity: 10 }, A));

  const sheet = store.runInTx(() => store.createStocktake({ lines: [{ itemId: item.id }] }, A));
  store.runInTx(() => store.updateStocktake(sheet.id, { lines: [{ itemId: item.id, countedQty: 12 }] }, A));
  store.runInTx(() => store.postStocktake(sheet.id, A));
  assert.equal(store.onHandOf(item.id), 12);

  let err;
  try {
    store.runInTx(() => store.postStocktake(sheet.id, A));
  } catch (e) {
    err = e;
  }
  assert.ok(err, '重复过账必须抛错');
  assert.equal(err.status, 409);
  assert.equal(err.code, 'INVALID_STATE');
  assert.equal(store.onHandOf(item.id), 12, '结存不得重复累加');
});

test('未录入实盘不能过账；差异为 0 不写流水', () => {
  const item = store.runInTx(() => store.createItem({ sku: S(3), name: '盘点物料C' }, A));
  store.runInTx(() => store.insertMovement({ itemId: item.id, type: 'in', quantity: 8 }, A));

  const empty = store.runInTx(() => store.createStocktake({ lines: [{ itemId: item.id }] }, A));
  assert.throws(() => store.runInTx(() => store.postStocktake(empty.id, A)), /没有录入任何实盘数量/);

  const same = store.runInTx(() => store.createStocktake({ lines: [{ itemId: item.id }] }, A));
  store.runInTx(() => store.updateStocktake(same.id, { lines: [{ itemId: item.id, countedQty: 8 }] }, A));
  const posted = store.runInTx(() => store.postStocktake(same.id, A));
  assert.equal(posted.status, 'posted');
  assert.equal(store.onHandOf(item.id), 8);
  assert.equal(
    store.listMovements({ itemId: item.id, type: 'stocktake', page: 1, pageSize: 10, offset: 0 }).total,
    0,
    '差异为 0 不应写流水',
  );
});

test('过账后不能再修改或作废', () => {
  const item = store.runInTx(() => store.createItem({ sku: S(4), name: '盘点物料D' }, A));
  store.runInTx(() => store.insertMovement({ itemId: item.id, type: 'in', quantity: 4 }, A));
  const sheet = store.runInTx(() => store.createStocktake({ lines: [{ itemId: item.id }] }, A));
  store.runInTx(() => store.updateStocktake(sheet.id, { lines: [{ itemId: item.id, countedQty: 5 }] }, A));
  store.runInTx(() => store.postStocktake(sheet.id, A));

  assert.throws(() => store.runInTx(() => store.cancelStocktake(sheet.id, A)), /已过账/);
  assert.throws(
    () => store.runInTx(() => store.updateStocktake(sheet.id, { lines: [{ itemId: item.id, countedQty: 9 }] }, A)),
    /已过账/,
  );
});

test('草稿盘点单可作废，之后不能过账', () => {
  const item = store.runInTx(() => store.createItem({ sku: S(5), name: '盘点物料E' }, A));
  store.runInTx(() => store.insertMovement({ itemId: item.id, type: 'in', quantity: 3 }, A));
  const sheet = store.runInTx(() => store.createStocktake({ lines: [{ itemId: item.id }] }, A));
  const cancelled = store.runInTx(() => store.cancelStocktake(sheet.id, A));
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(() => store.runInTx(() => store.postStocktake(sheet.id, A)), /已作废/);
});

test.after(() => tmp.cleanup());
