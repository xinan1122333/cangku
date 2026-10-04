/**
 * 部分更新（PATCH）语义回归测试 —— 针对 BUG-3。
 *
 * 核心契约：**只有 undefined 才表示「未提供、保持原值」**；
 * 显式传 null / '' 表示清空，显式传 0 表示写入 0。
 *
 * 这个 bug 的真实后果：PATCH 只改 name 会把 barcode 清成 NULL，
 * 导致 /api/scan/resolve 再也扫不到该物料（扫码作业直接失效）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { actor, bootstrap, loadDb, loadStore, uniq, useTempDb } from './helpers.mjs';
import { itemPatchSchema, rolePatchSchema, stocktakePatchSchema } from '../src/lib/validate.ts';

const tmp = useTempDb('patch');
const store = await loadStore();
const db = (await loadDb()).getDb();
bootstrap(db);

const A = actor('改料员');
const P = uniq('PATCH');
const S = (n) => `${P}-${n}`;

/** 建一个字段齐全的物料 */
function makeFullItem(sku) {
  return store.runInTx(() =>
    store.createItem(
      {
        sku,
        name: '原始名称',
        spec: '规格X',
        unit: '箱',
        category: '五金',
        barcode: `${sku}-BAR`,
        location: 'A-01-02',
        safetyStock: 7,
        remark: '原备注',
      },
      A,
    ),
  );
}

test('zod: PATCH schema 不得把未提供的键物化成 null', () => {
  const parsed = itemPatchSchema.safeParse({ name: '新名字' });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.name, '新名字');
  // 关键：未提供的字段必须是 undefined（缺失），而不是 null
  for (const key of ['barcode', 'spec', 'category', 'location', 'remark', 'unit', 'safetyStock', 'status', 'sku']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(parsed.data, key),
      false,
      `未提供的字段 ${key} 不应出现在解析结果中（实际值 ${JSON.stringify(parsed.data[key])}）`,
    );
  }
});

test('zod: 显式 null / 空串 仍表示清空，显式 0 仍写入 0', () => {
  const cleared = itemPatchSchema.safeParse({ barcode: null, location: '' });
  assert.equal(cleared.data.barcode, null, '显式 null 必须表示清空');
  assert.equal(cleared.data.location, null, '空串应归一化为 null（清空）');

  const zero = itemPatchSchema.safeParse({ safetyStock: 0 });
  assert.equal(zero.data.safetyStock, 0, '显式 0 必须被保留，不能当成「未提供」');

  const text = itemPatchSchema.safeParse({ barcode: 'NEW-BC' });
  assert.equal(text.data.barcode, 'NEW-BC');
});

test('★ PATCH 只改 name：其余字段（含 barcode）必须保持原值', () => {
  const sku = S(1);
  const item = makeFullItem(sku);

  const updated = store.runInTx(() => store.updateItem(item.id, { name: '改后名称' }, A));

  assert.equal(updated.name, '改后名称', 'name 必须更新');
  assert.equal(updated.barcode, `${sku}-BAR`, '★ barcode 绝不能被清空');
  assert.equal(updated.spec, '规格X', 'spec 必须保持');
  assert.equal(updated.category, '五金', 'category 必须保持');
  assert.equal(updated.location, 'A-01-02', 'location 必须保持');
  assert.equal(updated.remark, '原备注', 'remark 必须保持');
  assert.equal(updated.unit, '箱', 'unit 必须保持（不能被重置为「件」）');
  assert.equal(updated.safetyStock, 7, 'safetyStock 必须保持');
  assert.equal(updated.sku, sku, 'sku 必须保持');

  // 数据库里也必须是原值（防止只改了返回值）
  const raw = db.prepare('SELECT barcode, location, unit, safety_stock FROM items WHERE id = ?').get(item.id);
  assert.equal(raw.barcode, `${sku}-BAR`);
  assert.equal(raw.location, 'A-01-02');
  assert.equal(raw.unit, '箱');
  assert.equal(raw.safety_stock, 7);
});

test('★ 同类缺陷：rolePatchSchema / stocktakePatchSchema 也不得物化 null', () => {
  const role = rolePatchSchema.safeParse({ name: '新角色名' });
  assert.equal(
    Object.prototype.hasOwnProperty.call(role.data, 'description'),
    false,
    '未提供 description 时不得出现该键（否则会清空角色描述）',
  );

  const sheet = stocktakePatchSchema.safeParse({ lines: [{ itemId: 'x', countedQty: 5 }] });
  assert.equal(Object.prototype.hasOwnProperty.call(sheet.data, 'location'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sheet.data, 'remark'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sheet.data.lines[0], 'remark'), false);

  // 显式清空仍有效
  const clearedRole = rolePatchSchema.safeParse({ description: '' });
  assert.equal(clearedRole.data.description, null, '角色描述空串仍应表示清空');
});

test('★ 盘点单 PATCH 只录入实盘：location/remark 保持原值', () => {
  const sku = S(9);
  const item = store.runInTx(() => store.createItem({ sku, name: '盘点保持用例' }, A));
  store.runInTx(() => store.insertMovement({ itemId: item.id, type: 'in', quantity: 6 }, A));

  const sheet = store.runInTx(() =>
    store.createStocktake({ location: 'C区', remark: '原盘点备注', lines: [{ itemId: item.id }] }, A),
  );
  assert.equal(sheet.location, 'C区');

  const updated = store.runInTx(() =>
    store.updateStocktake(sheet.id, { lines: [{ itemId: item.id, countedQty: 5 }] }, A),
  );
  assert.equal(updated.location, 'C区', '★ 未提供 location 时必须保持原值');
  assert.equal(updated.remark, '原盘点备注', '★ 未提供 remark 时必须保持原值');
  assert.equal(updated.lines[0].countedQty, 5);
});
test('★ PATCH 后条码仍可被扫码解析到（BUG-3 的真实业务后果）', () => {
  const sku = S(2);
  const item = makeFullItem(sku);
  const barcode = `${sku}-BAR`;

  assert.equal(store.resolveScanCode(barcode).id, item.id, 'PATCH 前应能扫到');

  store.runInTx(() => store.updateItem(item.id, { name: '再来一次' }, A));

  const hit = store.resolveScanCode(barcode);
  assert.ok(hit, '★ PATCH 后必须仍能扫到该条码');
  assert.equal(hit.id, item.id);
  assert.equal(hit.barcode, barcode);
});

test('PATCH 显式传 null 才清空 barcode', () => {
  const sku = S(3);
  const item = makeFullItem(sku);
  const updated = store.runInTx(() => store.updateItem(item.id, { barcode: null }, A));
  assert.equal(updated.barcode, null, '显式 null 应清空');
  assert.equal(store.resolveScanCode(`${sku}-BAR`), null, '清空后不应再扫到');
  // 但其它字段不受影响
  assert.equal(updated.location, 'A-01-02');
});

test('PATCH safetyStock:0 必须真的写入 0（不能用 ?? 忽略）', () => {
  const sku = S(4);
  const item = makeFullItem(sku);
  assert.equal(item.safetyStock, 7);
  const updated = store.runInTx(() => store.updateItem(item.id, { safetyStock: 0 }, A));
  assert.equal(updated.safetyStock, 0, '显式 0 必须生效');
  const raw = db.prepare('SELECT safety_stock AS s FROM items WHERE id = ?').get(item.id);
  assert.equal(raw.s, 0);
});

test('PATCH 多字段同时更新，未列出的字段保持原值', () => {
  const sku = S(5);
  const item = makeFullItem(sku);
  const updated = store.runInTx(() =>
    store.updateItem(item.id, { location: 'B-09-09', remark: '新备注' }, A),
  );
  assert.equal(updated.location, 'B-09-09');
  assert.equal(updated.remark, '新备注');
  assert.equal(updated.barcode, `${sku}-BAR`, 'barcode 仍未受影响');
  assert.equal(updated.category, '五金', 'category 保持原值');
  assert.equal(updated.spec, '规格X');
});

test('审计日志记录了变更前后，便于追溯清空类问题', () => {
  const sku = S(6);
  const item = makeFullItem(sku);
  store.runInTx(() => store.updateItem(item.id, { name: '审计用例' }, A));
  const logs = store.listAuditLogs({ entity: 'item', action: 'item.update', page: 1, pageSize: 50, offset: 0 });
  const entry = logs.rows.find((l) => l.entityId === item.id);
  assert.ok(entry, '必须有 item.update 审计');
  assert.equal(entry.detail.before.barcode, `${sku}-BAR`);
  assert.equal(entry.detail.after.barcode, `${sku}-BAR`, '审计里 after 也不得丢失 barcode');
});

test.after(() => tmp.cleanup());
