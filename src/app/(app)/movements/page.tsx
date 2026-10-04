"use client";

/**
 * 进出明细：按物料/类型/日期筛选、分页、入库/出库/调整表单、导出 CSV。
 * 契约 §4：GET/POST /api/movements，GET /api/export/movements（movement:export）。
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, openExport, readErrorMessage, request } from "../../_components/api";
import type { Item, Movement, Page } from "../../_components/api";
import { MovementForm } from "../../_components/movement-form";
import { useSession } from "../../_components/session";
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Drawer,
  EmptyState,
  Field,
  Input,
  Loading,
  MOVEMENT_TYPE_LABEL,
  MobileCard,
  MobileCards,
  PageHeader,
  Pagination,
  Section,
  Select,
  TableDesktop,
  TableWrap,
  Td,
  Th,
  formatDateTime,
  styles,
} from "../../_components/ui";

const PAGE_SIZE = 20;

export default function MovementsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <MovementsPageInner />
    </Suspense>
  );
}

function MovementsPageInner() {
  const { can } = useSession();
  const [rows, setRows] = useState<Movement[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [type, setType] = useState("");
  const [itemId, setItemId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [keyword, setKeyword] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formItem, setFormItem] = useState<Item | null>(null);
  const ticketRef = useRef(0);

  const canWrite = can("movement:write");
  const canExport = can("movement:export");

  const load = useCallback(async () => {
    const ticket = ++ticketRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await request<Page<Movement>>("/api/movements", {
        query: {
          itemId: itemId || undefined,
          type: type || undefined,
          from: from || undefined,
          to: to || undefined,
          q: keyword || undefined,
          page,
          pageSize: PAGE_SIZE,
        },
      });
      if (ticket !== ticketRef.current) return;
      setRows(result.rows ?? []);
      setTotal(result.total ?? 0);
    } catch (err) {
      if (ticket !== ticketRef.current) return;
      setError(readErrorMessage(err));
      setRows([]);
      setTotal(0);
    } finally {
      if (ticket === ticketRef.current) setLoading(false);
    }
  }, [itemId, type, from, to, keyword, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // 物料下拉（用于筛选与新建流水）
  useEffect(() => {
    if (!can("item:read")) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await request<Page<Item>>("/api/items", { query: { page: 1, pageSize: 500 } });
        if (!cancelled) setItems(result.rows ?? []);
      } catch {
        // 忽略：无权限或无数据
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [can]);

  function resetFilters() {
    setType("");
    setItemId("");
    setFrom("");
    setTo("");
    setKeyword("");
    setPage(1);
  }

  const exportQuery = {
    itemId: itemId || undefined,
    type: type || undefined,
    from: from || undefined,
    to: to || undefined,
  };

  return (
    <>
      <PageHeader
        title="进出明细"
        description="库存流水真源 · 支持入库/出库/调整与 CSV 导出"
        actions={
          <>
            <Button
              variant="primary"
              disabled={!canWrite}
              title={canWrite ? undefined : "需要 movement:write 权限"}
              onClick={() => {
                setFormItem(null);
                setFormOpen(true);
              }}
            >
              + 登记出入库
            </Button>
            {canExport ? (
              <ButtonLink href={`/api/export/movements${buildQuery(exportQuery)}`} variant="secondary">
                导出 CSV
              </ButtonLink>
            ) : (
              <Button disabled title="需要 movement:export 权限">
                导出 CSV
              </Button>
            )}
          </>
        }
      />

      {error ? (
        <Alert kind="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert kind="success" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      ) : null}
      {!canExport ? (
        <Alert kind="info">当前角色无 movement:export 权限，导出按钮已禁用。</Alert>
      ) : null}

      <Section>
        <div className={styles.filterBar}>
          <Field label="物料" className={styles.flex1}>
            <Select
              value={itemId}
              onChange={(e) => {
                setItemId(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部物料</option>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.sku} · {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="类型" className={styles.w32}>
            <Select
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部类型</option>
              <option value="in">入库</option>
              <option value="out">出库</option>
              <option value="adjust">调整</option>
              <option value="stocktake">盘点</option>
            </Select>
          </Field>
          <Field label="起始日期" className={styles.w40}>
            <Input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </Field>
          <Field label="结束日期" className={styles.w40}>
            <Input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
            />
          </Field>
          <div className={styles.actions}>
            <Button onClick={resetFilters}>重置</Button>
          </div>
        </div>

        <form
          className={styles.filterBar}
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            void load();
          }}
        >
          <Field label="备注/单号关键字" className={styles.flex1}>
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="按单号或备注过滤（服务端支持时生效）"
            />
          </Field>
          <div className={styles.actions}>
            <Button variant="primary" type="submit">
              查询
            </Button>
          </div>
        </form>

        {loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState>没有符合条件的流水记录</EmptyState>
        ) : (
          <>
            <MobileCards>
              {rows.map((row) => (
                <MobileCard
                  key={row.id}
                  title={`#${row.seq} ${MOVEMENT_TYPE_LABEL[row.type] ?? row.type}`}
                  subtitle={formatDateTime(row.occurredAt)}
                  badge={
                    <span className={row.signedQuantity >= 0 ? styles.deltaPos : styles.deltaNeg}>
                      {row.signedQuantity >= 0 ? "+" : ""}
                      {row.signedQuantity}
                    </span>
                  }
                  rows={[
                    { label: "物料", value: row.itemName || row.sku || row.itemId.slice(0, 8) },
                    { label: "结存前", value: row.beforeQty },
                    { label: "结存后", value: row.afterQty },
                    { label: "单号", value: row.refNo || "—" },
                    { label: "对方", value: row.partner || "—" },
                    { label: "操作人", value: row.operatorName || "—" },
                  ]}
                />
              ))}
            </MobileCards>

            <TableDesktop>
              <TableWrap>
                <thead>
                  <tr>
                    <Th>序号</Th>
                    <Th>时间</Th>
                    <Th>物料</Th>
                    <Th>类型</Th>
                    <Th className={styles.right}>数量</Th>
                    <Th className={styles.right}>结存前→后</Th>
                    <Th>单号</Th>
                    <Th>对方</Th>
                    <Th>操作人</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <Td className={styles.mono}>{row.seq}</Td>
                      <Td className={styles.nowrap}>{formatDateTime(row.occurredAt)}</Td>
                      <Td>{row.itemName || row.sku || row.itemId.slice(0, 8)}</Td>
                      <Td>
                        <Badge tone={row.type === "in" ? "green" : row.type === "out" ? "red" : "blue"}>
                          {MOVEMENT_TYPE_LABEL[row.type] ?? row.type}
                        </Badge>
                      </Td>
                      <Td className={styles.right}>
                        <span className={row.signedQuantity >= 0 ? styles.deltaPos : styles.deltaNeg}>
                          {row.signedQuantity >= 0 ? "+" : ""}
                          {row.signedQuantity}
                        </span>
                      </Td>
                      <Td className={styles.right}>
                        {row.beforeQty} → {row.afterQty}
                      </Td>
                      <Td>{row.refNo || "—"}</Td>
                      <Td>{row.partner || "—"}</Td>
                      <Td>{row.operatorName || "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </TableDesktop>
          </>
        )}

        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
      </Section>

      <Drawer
        open={formOpen}
        title="登记出入库"
        onClose={() => setFormOpen(false)}
        footer={
          <div className={styles.actions} style={{ justifyContent: "flex-end" }}>
            <Button onClick={() => setFormOpen(false)}>关闭</Button>
          </div>
        }
      >
        {!canWrite ? <Alert kind="warning">当前角色无 movement:write 权限，无法登记。</Alert> : null}
        <div className={styles.stack}>
          <Field label="选择物料">
            <Select
              value={formItem?.id ?? ""}
              onChange={(e) => {
                const found = items.find((it) => it.id === e.target.value) ?? null;
                setFormItem(found);
              }}
            >
              <option value="">请选择物料…</option>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.sku} · {item.name}
                </option>
              ))}
            </Select>
          </Field>

          {formItem ? (
            <MovementForm
              key={formItem.id}
              item={formItem}
              onHand={formItem.onHand ?? null}
              disabled={!canWrite}
              disabledReason="当前角色无 movement:write 权限"
              onDone={() => {
                setNotice(`已登记物料「${formItem.name}」的出入库`);
                void load();
              }}
            />
          ) : (
            <p className={styles.muted}>先选择物料，再填写数量与类型。</p>
          )}
        </div>
      </Drawer>
    </>
  );
}

function buildQuery(query: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) sp.set(key, value);
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

/** 提供给其它页面复用的导出入口 */
export function exportMovements(query: Record<string, string | number | undefined>): void {
  openExport("/api/export/movements", query);
}
