import { getSession, hasPermission } from '@/lib/auth';
import { fail, parseTimeParam } from '@/lib/http';
import { listMovementsForExport } from '@/lib/store';
import type { MovementDto } from '@/types/api';

/**
 * GET /api/export/movements?itemId=&type=&from=&to=&refNo=&q=
 * 契约 §4：权限 movement:export，返回 CSV（UTF-8 BOM，Excel 友好）。
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = [
  '序号',
  '发生时间',
  '物料SKU',
  '物料名称',
  '类型',
  '数量',
  '带符号数量',
  '记账前结存',
  '记账后结存',
  '单位成本(分)',
  '关联单号',
  '供应商/领用人',
  '原因',
  '备注',
  '操作人',
  '记录时间',
] as const;

const TYPE_LABEL: Record<string, string> = {
  in: '入库',
  out: '出库',
  adjust: '调整',
  stocktake: '盘点',
};

const MOVEMENT_TYPE_LABEL = TYPE_LABEL;

/** CSV 单元格转义：含分隔符/引号/换行时用双引号包裹 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** 时间戳 → `YYYY-MM-DD HH:mm:ss`（本地时区，便于人工核对） */
function formatTime(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

function toRow(m: MovementDto): string[] {
  return [
    String(m.seq ?? ''),
    formatTime(m.occurredAt),
    m.sku ?? '',
    m.itemName ?? '',
    MOVEMENT_TYPE_LABEL[m.type] ?? m.type ?? '',
    String(m.quantity ?? ''),
    String(m.signedQuantity ?? ''),
    String(m.beforeQty ?? ''),
    String(m.afterQty ?? ''),
    m.unitCost === null || m.unitCost === undefined ? '' : String(m.unitCost),
    m.refNo ?? '',
    m.partner ?? '',
    m.reason ?? '',
    m.remark ?? '',
    m.operatorName ?? '',
    formatTime(m.createdAt),
  ];
}

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return fail(401, 'UNAUTHORIZED', '未登录或会话已过期');
  if (!hasPermission(session.permissions, 'movement:export')) {
    return fail(403, 'FORBIDDEN', '无权限导出流水');
  }

  try {
    const url = new URL(request.url);
    const rows = listMovementsForExport({
      itemId: url.searchParams.get('itemId') ?? undefined,
      type: url.searchParams.get('type') ?? undefined,
      from: parseTimeParam(url.searchParams.get('from')),
      to: parseTimeParam(url.searchParams.get('to'), true),
      refNo: url.searchParams.get('refNo') ?? undefined,
      q: url.searchParams.get('q') ?? undefined,
    });

    const lines: string[] = [HEADERS.join(',')];
    for (const row of rows) {
      lines.push(toRow(row).map(csvCell).join(','));
    }

    // UTF-8 BOM：Excel 正确识别中文
    const body = `\uFEFF${lines.join('\r\n')}\r\n`;
    const stamp = formatTime(Date.now()).replace(/[: ]/g, '-');
    const filename = `movements-${stamp}.csv`;

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(
          filename,
        )}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    if (typeof e?.status === 'number' && typeof e?.code === 'string') {
      return fail(e.status, e.code, e.message ?? '导出失败');
    }
    console.error('[wms] 导出流水失败：', err);
    return fail(500, 'INTERNAL_ERROR', '导出流水失败');
  }
}
