import { z } from 'zod';

/** 通用可选文本：空字符串统一转 null */
const optionalText = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((v) => (v === undefined || v === '' ? null : v));

/** 必填短文本 */
export const requiredText = (label: string, max = 100) =>
  z.string().trim().min(1, `${label}不能为空`).max(max, `${label}过长`);

/** 整数（最小单位） */
export const intQty = z.coerce.number().int('数量必须是整数');

export const positiveQty = intQty.refine((v) => v > 0, '数量必须大于 0');

/** itemId 等主键 */
export const idText = requiredText('ID', 64);

/** 分页 */
export const pageQuery = {
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
};

/** 登录 */
export const loginSchema = z.object({
  username: requiredText('用户名', 64),
  password: z.string().min(1, '密码不能为空').max(200, '密码过长'),
});

/** 修改自己的密码 */
export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, '原密码不能为空'),
  newPassword: z.string().min(6, '新密码至少 6 位').max(200, '新密码过长'),
});

/** 新建物料 */
export const itemCreateSchema = z.object({
  sku: requiredText('SKU', 64),
  name: requiredText('名称', 100),
  spec: optionalText,
  unit: z
    .string()
    .trim()
    .max(20)
    .nullish()
    .transform((v) => (v ? v : '件')),
  category: optionalText,
  barcode: optionalText,
  location: optionalText,
  safetyStock: z.coerce
    .number()
    .int()
    .min(0, '安全库存不能为负')
    .nullish()
    .transform((v) => (v === null || v === undefined ? 0 : v)),
  remark: optionalText,
  status: z.enum(['active', 'disabled']).optional(),
});

/**
 * 可空文本（**部分更新用**）：严格保留「未提供」语义。
 *   - 键缺失 / undefined -> 输出 undefined（表示「不修改该字段」）
 *   - 显式 null 或空串  -> 输出 null（表示「清空该字段」）
 *
 * ⚠️ 不要用它之外的方式表达「未提供」：`.optional().transform()` 会把缺失键物化成 null，
 * 在 PATCH 场景下会被误判为「要求清空」，从而静默清空 barcode 等字段（见 tests/patch.test.mjs）。
 */
const optionalTextForPatch = z
  .string()
  .trim()
  .max(200)
  .nullish()
  .transform((v) => (v === undefined ? undefined : v === '' ? null : v));

/** 数字（**部分更新用**）：未提供保持 undefined，显式 null/0 保留 */
const optionalIntForPatch = z.coerce
  .number()
  .int()
  .min(0)
  .nullish()
  .transform((v) => (v === undefined || v === null ? undefined : v));

/** 修改物料（部分更新）：所有字段可选，且**未提供的字段必须保持 undefined** */
export const itemPatchSchema = z.object({
  sku: requiredText('SKU', 64).optional(),
  name: requiredText('名称', 100).optional(),
  spec: optionalTextForPatch,
  unit: z
    .string()
    .trim()
    .max(20)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v ? v : '件')),
  category: optionalTextForPatch,
  barcode: optionalTextForPatch,
  location: optionalTextForPatch,
  safetyStock: optionalIntForPatch,
  remark: optionalTextForPatch,
  status: z.enum(['active', 'disabled']).optional(),
});

/** 出入库 / 调整 */
export const movementCreateSchema = z
  .object({
    itemId: idText,
    type: z.enum(['in', 'out', 'adjust'], {
      message: 'type 只能是 in/out/adjust（stocktake 由盘点过账产生）',
    }),
    quantity: intQty.optional(),
    /** targetQty 允许为 0，但不允许负数（adjust 通过盘点单处理负数场景） */
    targetQty: intQty.refine((v) => v >= 0, '目标数量不能为负').optional(),
    unitCost: z.coerce.number().int('成本必须是整数分').min(0).optional(),
    refNo: optionalText,
    partner: optionalText,
    reason: optionalText,
    remark: optionalText,
    occurredAt: z.coerce.number().int().optional(),
    allowNegative: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type === 'adjust') {
      if (val.targetQty === undefined) {
        ctx.addIssue({ code: 'custom', path: ['targetQty'], message: 'adjust 必须提供 targetQty' });
      }
    } else if (val.quantity === undefined) {
      ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'quantity 不能为空' });
    } else if (val.quantity <= 0) {
      ctx.addIssue({ code: 'custom', path: ['quantity'], message: '数量必须大于 0' });
    }
  });

/** 盘点单 */
export const stocktakeCreateSchema = z.object({
  code: z.string().trim().max(64).optional(),
  location: optionalText,
  remark: optionalText,
  lines: z
    .array(
      z.object({
        itemId: idText,
        countedQty: intQty.refine((v) => v >= 0, '实盘数量不能为负').optional(),
        remark: optionalText,
      }),
    )
    .optional()
    .default([]),
});

/** 盘点单更新：录入实盘 / 取消 / 过账（部分更新：未提供字段必须保持 undefined） */
export const stocktakePatchSchema = z.object({
  action: z.enum(['post', 'cancel']).optional(),
  location: optionalTextForPatch,
  remark: optionalTextForPatch,
  lines: z
    .array(
      z.object({
        id: z.string().trim().max(64).optional(),
        itemId: z.string().trim().max(64).optional(),
        countedQty: intQty.refine((v) => v >= 0, '实盘数量不能为负'),
        remark: optionalTextForPatch,
      }),
    )
    .optional(),
});

/** 用户 */
export const userCreateSchema = z.object({
  username: requiredText('用户名', 64),
  displayName: requiredText('显示名', 64),
  password: z.string().min(6, '密码至少 6 位').max(200, '密码过长'),
  roleId: idText,
  status: z.enum(['active', 'disabled']).optional(),
});

export const userPatchSchema = z.object({
  displayName: requiredText('显示名', 64).optional(),
  password: z.string().min(6, '密码至少 6 位').max(200).optional(),
  roleId: idText.optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

/** 角色 */
export const roleCreateSchema = z.object({
  code: requiredText('角色代码', 32),
  name: requiredText('角色名称', 64),
  description: optionalText,
  permissions: z.array(z.string().trim().min(1)).optional().default([]),
});

export const rolePatchSchema = z.object({
  name: requiredText('角色名称', 64).optional(),
  description: optionalTextForPatch,
  permissions: z.array(z.string().trim().min(1)).optional(),
});

/** 归一化：把 zod 结果里的 undefined 转成 null（SQLite 绑定不接受 undefined） */
export function nullify<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === undefined ? null : v;
  return out;
}

export { z };
