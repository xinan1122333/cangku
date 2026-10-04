"use client";

/**
 * 物料档案：列表 + 搜索 + 分页 + 新建/编辑抽屉（条码、SKU、库位、安全库存、停用）。
 * 契约 §4：GET/POST /api/items，GET/PATCH/DELETE /api/items/[id]。
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ApiError, readErrorMessage, request } from "../../_components/api";
import type { Item, Page, StockRow } from "../../_components/api";
import { useSession } from "../../_components/session";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Drawer,
  EmptyState,
  Field,
  Input,
  Loading,
  MobileCard,
  MobileCards,
  PageHeader,
  Pagination,
  Section,
  Select,
  TableDesktop,
  TableWrap,
  Td,
  Textarea,
  Th,
  styles,
} from "../../_components/ui";

type ItemFormState = {
  sku: string;
  name: string;
  spec: string;
  unit: string;
  category: string;
  barcode: string;
  location: string;
  safetyStock: string;
  remark: string;
  status: string;
  /** 仅新建时可用：期初库存（走 initQty，同一事务写流水） */
  initQty: string;
};

const EMPTY_FORM: ItemFormState = {
  sku: "",
  name: "",
  spec: "",
  unit: "件",
  category: "",
  barcode: "",
  location: "",
  safetyStock: "0",
  remark: "",
  status: "active",
  initQty: "",
};

const PAGE_SIZE = 20;

export default function ItemsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ItemsPageInner />
    </Suspense>
  );
}

function ItemsPageInner() {
  const { me, can } = useSession();
  const searchParams = useSearchParams();
  const initialLowOnly = searchParams?.get("lowOnly") === "1";
  const initialBarcode = searchParams?.get("barcode") ?? "";
  const initialKeyword = searchParams?.get("q") ?? "";

  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState(initialKeyword);
  const [appliedKeyword, setAppliedKeyword] = useState(initialKeyword);
  const [status, setStatus] = useState("active");
  const [lowOnly, setLowOnly] = useState(initialLowOnly);
  const [stockMap, setStockMap] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState<Item | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(initialBarcode !== "");
  const [form, setForm] = useState<ItemFormState>({ ...EMPTY_FORM, barcode: initialBarcode });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const canWrite = can("item:write");
  const canStock = can("stock:read");
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await request<Page<Item>>("/api/items", {
        query: {
          q: appliedKeyword,
          page,
          pageSize: PAGE_SIZE,
          status: status === "all" ? undefined : status,
        },
      });
      if (ticket !== requestId.current) return;
      setItems(result.rows ?? []);
      setTotal(result.total ?? 0);

      if (canStock) {
        try {
          const stock = await request<StockRow[] | Page<StockRow>>("/api/stock", {
            query: { q: appliedKeyword, page: 1, pageSize: 200 },
          });
          const rows = Array.isArray(stock) ? stock : (stock.rows ?? []);
          const map: Record<string, number> = {};
          for (const row of rows) map[row.id] = row.onHand;
          if (ticket === requestId.current) setStockMap(map);
        } catch {
          // 结存失败不影响主列表
        }
      }
    } catch (err) {
      if (ticket !== requestId.current) return;
      setError(readErrorMessage(err));
      setItems([]);
      setTotal(0);
    } finally {
      if (ticket === requestId.current) setLoading(false);
    }
  }, [appliedKeyword, page, status, canStock]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleItems = useMemo(() => {
    if (!lowOnly) return items;
    return items.filter((item) => {
      const onHand = stockMap[item.id];
      if (onHand === undefined) return false;
      return onHand <= (item.safetyStock ?? 0);
    });
  }, [items, lowOnly, stockMap]);

  function openCreate(preset?: Partial<ItemFormState>) {
    setEditing(null);
    setForm({ ...EMPTY_FORM, ...preset });
    setFormError(null);
    setDrawerOpen(true);
  }

  function openEdit(item: Item) {
    setEditing(item);
    setForm({
      sku: item.sku ?? "",
      name: item.name ?? "",
      spec: item.spec ?? "",
      unit: item.unit ?? "件",
      category: item.category ?? "",
      barcode: item.barcode ?? "",
      location: item.location ?? "",
      safetyStock: String(item.safetyStock ?? 0),
      remark: item.remark ?? "",
      status: item.status ?? "active",
      initQty: "",
    });
    setFormError(null);
    setDrawerOpen(true);
  }

  async function save() {
    setFormError(null);
    if (!form.sku.trim()) {
      setFormError("SKU 不能为空");
      return;
    }
    if (!form.name.trim()) {
      setFormError("物料名称不能为空");
      return;
    }
    const safety = Number(form.safetyStock || 0);
    if (!Number.isInteger(safety) || safety < 0) {
      setFormError("安全库存必须是不小于 0 的整数");
      return;
    }

    const body = {
      sku: form.sku.trim(),
      name: form.name.trim(),
      spec: form.spec.trim() || null,
      unit: form.unit.trim() || "件",
      category: form.category.trim() || null,
      barcode: form.barcode.trim() || null,
      location: form.location.trim() || null,
      safetyStock: safety,
      remark: form.remark.trim() || null,
      status: form.status,
    };

    setSaving(true);
    try {
      if (editing) {
        await request(`/api/items/${encodeURIComponent(editing.id)}`, { method: "PATCH", body });
        setNotice(`已更新物料「${body.name}」`);
      } else {
        // 新建时可带期初库存：POST /api/items 支持 initQty（与建料同事务）
        const initQty = Number(form.initQty);
        const payload =
          form.initQty.trim() && Number.isInteger(initQty) && initQty > 0
            ? { ...body, initQty: { quantity: initQty } }
            : body;
        await request("/api/items", { method: "POST", body: payload });
        setNotice(
          form.initQty.trim() && initQty > 0
            ? `已创建物料「${body.name}」并记期初库存 ${initQty}`
            : `已创建物料「${body.name}」`,
        );
      }
      setDrawerOpen(false);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setFormError(`保存失败：${err.message}（SKU 或条码可能已存在）`);
      } else {
        setFormError(readErrorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  }

  async function disableItem(item: Item) {
    if (typeof window !== "undefined" && !window.confirm(`确定停用物料「${item.name}」吗？`)) return;
    setError(null);
    try {
      await request(`/api/items/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      setNotice(`已停用物料「${item.name}」`);
      await load();
    } catch (err) {
      setError(readErrorMessage(err));
    }
  }

  return (
    <>
      <PageHeader
        title="物料档案"
        description="维护 SKU、条码、库位与安全库存"
        actions={
          <Button
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : "需要 item:write 权限"}
            onClick={() => openCreate()}
          >
            + 新建物料
          </Button>
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

      <Section>
        <form
          className={styles.filterBar}
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setAppliedKeyword(keyword.trim());
          }}
        >
          <Field label="搜索" className={styles.flex1}>
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="SKU / 名称 / 条码 / 库位"
            />
          </Field>
          <Field label="状态" className={styles.w32}>
            <Select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="active">启用中</option>
              <option value="disabled">已停用</option>
              <option value="all">全部</option>
            </Select>
          </Field>
          <div className={styles.actions}>
            <Button variant="primary" type="submit">
              查询
            </Button>
            <Button
              onClick={() => {
                setKeyword("");
                setAppliedKeyword("");
                setPage(1);
              }}
            >
              重置
            </Button>
          </div>
        </form>

        {canStock ? (
          <div style={{ marginBottom: 12 }}>
            <Checkbox
              label="只看低库存（结存 ≤ 安全库存）"
              checked={lowOnly}
              onChange={(e) => setLowOnly(e.target.checked)}
            />
          </div>
        ) : null}

        {loading ? (
          <Loading />
        ) : visibleItems.length === 0 ? (
          <EmptyState>{lowOnly ? "没有低库存物料" : "暂无物料，先新建一个吧"}</EmptyState>
        ) : (
          <>
            <MobileCards>
              {visibleItems.map((item) => {
                const onHand = stockMap[item.id];
                const low = onHand !== undefined && onHand <= (item.safetyStock ?? 0);
                return (
                  <MobileCard
                    key={item.id}
                    title={item.name}
                    subtitle={`${item.sku}${item.barcode ? ` · ${item.barcode}` : ""}`}
                    badge={
                      item.status === "active" ? (
                        low ? (
                          <Badge tone="red">低库存</Badge>
                        ) : (
                          <Badge tone="green">启用</Badge>
                        )
                      ) : (
                        <Badge tone="slate">停用</Badge>
                      )
                    }
                    rows={[
                      { label: "规格", value: item.spec || "—" },
                      { label: "库位", value: item.location || "—" },
                      { label: "单位", value: item.unit || "—" },
                      { label: "安全库存", value: item.safetyStock ?? 0 },
                      { label: "结存", value: onHand ?? "—" },
                      { label: "分类", value: item.category || "—" },
                    ]}
                    actions={
                      <>
                        <Button size="sm" disabled={!canWrite} onClick={() => openEdit(item)}>
                          编辑
                        </Button>
                        {item.status === "active" ? (
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={!canWrite}
                            onClick={() => disableItem(item)}
                          >
                            停用
                          </Button>
                        ) : null}
                      </>
                    }
                  />
                );
              })}
            </MobileCards>

            <TableDesktop>
              <TableWrap>
                <thead>
                  <tr>
                    <Th>SKU</Th>
                    <Th>名称</Th>
                    <Th>规格</Th>
                    <Th>库位</Th>
                    <Th className={styles.right}>结存</Th>
                    <Th className={styles.right}>安全库存</Th>
                    <Th>条码</Th>
                    <Th>状态</Th>
                    <Th>操作</Th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((item) => {
                    const onHand = stockMap[item.id];
                    const low = onHand !== undefined && onHand <= (item.safetyStock ?? 0);
                    return (
                      <tr key={item.id}>
                        <Td className={styles.mono}>{item.sku}</Td>
                        <Td>{item.name}</Td>
                        <Td>{item.spec || "—"}</Td>
                        <Td>{item.location || "—"}</Td>
                        <Td className={styles.right}>
                          {onHand ?? "—"} {low ? <Badge tone="red">低</Badge> : null}
                        </Td>
                        <Td className={styles.right}>{item.safetyStock ?? 0}</Td>
                        <Td className={styles.mono}>{item.barcode || "—"}</Td>
                        <Td>
                          {item.status === "active" ? (
                            <Badge tone="green">启用</Badge>
                          ) : (
                            <Badge tone="slate">停用</Badge>
                          )}
                        </Td>
                        <Td>
                          <div className={styles.actions}>
                            <Button size="sm" disabled={!canWrite} onClick={() => openEdit(item)}>
                              编辑
                            </Button>
                            {item.status === "active" ? (
                              <Button
                                size="sm"
                                variant="danger"
                                disabled={!canWrite}
                                onClick={() => disableItem(item)}
                              >
                                停用
                              </Button>
                            ) : null}
                          </div>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </TableWrap>
            </TableDesktop>
          </>
        )}

        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
      </Section>

      <Drawer
        open={drawerOpen}
        title={editing ? `编辑物料 · ${editing.name}` : "新建物料"}
        onClose={() => setDrawerOpen(false)}
        footer={
          <div className={styles.actions} style={{ justifyContent: "flex-end" }}>
            <Button onClick={() => setDrawerOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" onClick={save} disabled={saving || !canWrite}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
        }
      >
        {!canWrite ? <Alert kind="warning">当前角色无 item:write 权限，无法保存。</Alert> : null}
        {formError ? (
          <Alert kind="error" onClose={() => setFormError(null)}>
            {formError}
          </Alert>
        ) : null}
        <div className={styles.formGrid}>
          <Field label="SKU *">
            <Input
              value={form.sku}
              onChange={(e) => setForm({ ...form, sku: e.target.value })}
              placeholder="SKU-0001"
            />
          </Field>
          <Field label="物料名称 *">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例如 内六角螺栓"
            />
          </Field>
          <Field label="规格">
            <Input
              value={form.spec}
              onChange={(e) => setForm({ ...form, spec: e.target.value })}
              placeholder="M6x20"
            />
          </Field>
          <Field label="单位">
            <Input
              value={form.unit}
              onChange={(e) => setForm({ ...form, unit: e.target.value })}
              placeholder="件 / 箱 / kg"
            />
          </Field>
          <Field label="条码" hint="扫码定位用，需唯一">
            <Input
              value={form.barcode}
              onChange={(e) => setForm({ ...form, barcode: e.target.value })}
              placeholder="6901234567890"
            />
          </Field>
          <Field label="库位">
            <Input
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              placeholder="A-01-02"
            />
          </Field>
          <Field label="分类">
            <Input
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              placeholder="紧固件"
            />
          </Field>
          <Field label="安全库存" hint="低于该值在仪表盘提示">
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={form.safetyStock}
              onChange={(e) => setForm({ ...form, safetyStock: e.target.value })}
            />
          </Field>
          <Field label="状态">
            <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="active">启用</option>
              <option value="disabled">停用</option>
            </Select>
          </Field>
          {editing === null ? (
            <Field label="期初库存" hint="选填，与建料同事务写入一条入库流水">
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={form.initQty}
                onChange={(e) => setForm({ ...form, initQty: e.target.value })}
                placeholder="留空表示 0"
              />
            </Field>
          ) : null}
          <div className={styles.span2}>
            <Field label="备注">
              <Textarea
                rows={2}
                value={form.remark}
                onChange={(e) => setForm({ ...form, remark: e.target.value })}
              />
            </Field>
          </div>
        </div>
        {me ? <p className={styles.hint}>操作人：{me.displayName}</p> : null}
      </Drawer>
    </>
  );
}
