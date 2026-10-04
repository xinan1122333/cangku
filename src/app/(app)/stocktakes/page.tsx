"use client";

/**
 * 盘点单：创建盘点单、录入实盘数、显示差异、过账。
 * 契约 §4：GET/POST /api/stocktakes，GET/PATCH/POST /api/stocktakes/[id]。
 */

import { useCallback, useEffect, useState } from "react";
import { readErrorMessage, request } from "../../_components/api";
import type { Stocktake, StocktakeLine } from "../../_components/api";
import { useSession } from "../../_components/session";
import {
  Alert,
  Badge,
  Button,
  Drawer,
  EmptyState,
  Field,
  Input,
  Loading,
  MobileCard,
  MobileCards,
  PageHeader,
  Section,
  STOCKTAKE_STATUS_LABEL,
  Select,
  TableDesktop,
  TableWrap,
  Td,
  Textarea,
  Th,
  formatDateTime,
  styles,
} from "../../_components/ui";

type ListShape = Stocktake[] | { rows: Stocktake[]; total: number };

function toRows(value: ListShape | null): Stocktake[] {
  if (!value) return [];
  return Array.isArray(value) ? value : (value.rows ?? []);
}

function statusTone(status: string): "slate" | "green" | "red" | "amber" | "blue" {
  switch (status) {
    case "posted":
      return "green";
    case "counting":
      return "blue";
    case "cancelled":
      return "slate";
    default:
      return "amber";
  }
}

export default function StocktakesPage() {
  const { can } = useSession();
  const [list, setList] = useState<Stocktake[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");

  const [detail, setDetail] = useState<Stocktake | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ location: "", remark: "" });

  const canWrite = can("stocktake:write");
  const canPost = can("stocktake:post");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await request<ListShape>("/api/stocktakes", {
        query: { status: statusFilter || undefined },
      });
      setList(toRows(result));
    } catch (err) {
      setError(readErrorMessage(err));
      setList([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(id: string) {
    setDetailLoading(true);
    setError(null);
    try {
      const data = await request<Stocktake>(`/api/stocktakes/${encodeURIComponent(id)}`);
      setDetail(data);
      const next: Record<string, string> = {};
      for (const line of data.lines ?? []) {
        next[line.id] = line.countedQty === null || line.countedQty === undefined ? "" : String(line.countedQty);
      }
      setCounts(next);
    } catch (err) {
      setError(readErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  }

  /** 保存实盘数（PATCH 只接受 { lines, location, remark }；状态由后端按录入自动推进） */
  async function saveCounts() {
    if (!detail) return;
    setSaving(true);
    setError(null);
    try {
      const lines = (detail.lines ?? []).map((line) => {
        const raw = counts[line.id];
        const countedQty =
          raw === "" || raw === undefined ? null : Number(raw);
        return countedQty === null
          ? { id: line.id, itemId: line.itemId }
          : { id: line.id, itemId: line.itemId, countedQty };
      });
      // 校验：countedQty 必填且非负，因此仅提交已录入的行
      const filled = lines.filter((l) => "countedQty" in l);
      if (filled.length === 0) {
        setError("请至少录入一行实盘数量后再保存");
        return;
      }
      await request(`/api/stocktakes/${encodeURIComponent(detail.id)}`, {
        method: "PATCH",
        body: { lines: filled },
      });
      setNotice("实盘数已保存");
      await openDetail(detail.id);
      await load();
    } catch (err) {
      setError(readErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function post() {
    if (!detail) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm("过账后将按差异生成盘点流水并更新结存，且不可撤销。确定继续吗？")
    ) {
      return;
    }
    setPosting(true);
    setError(null);
    try {
      await request(`/api/stocktakes/${encodeURIComponent(detail.id)}`, {
        method: "POST",
        body: { action: "post" },
      });
      setNotice(`盘点单 ${detail.code} 已过账`);
      setDetail(null);
      await load();
    } catch (err) {
      setError(readErrorMessage(err));
    } finally {
      setPosting(false);
    }
  }

  async function create() {
    setSaving(true);
    setError(null);
    try {
      const created = await request<Stocktake>("/api/stocktakes", {
        method: "POST",
        // 契约：lines 不传（空数组）即自动带出全部启用物料
        body: {
          location: createForm.location.trim() || null,
          remark: createForm.remark.trim() || null,
        },
      });
      setCreateOpen(false);
      setNotice(`已创建盘点单 ${created?.code ?? ""}`.trim());
      await load();
      if (created?.id) await openDetail(created.id);
    } catch (err) {
      setError(readErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="库存盘点"
        description="创建盘点单 → 录入实盘数 → 过账生成差异流水"
        actions={
          <Button
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : "需要 stocktake:write 权限"}
            onClick={() => setCreateOpen(true)}
          >
            + 新建盘点单
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

      <Section
        title="盘点单列表"
        actions={
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={styles.w32}>
            <option value="">全部状态</option>
            <option value="draft">草稿</option>
            <option value="counting">盘点中</option>
            <option value="posted">已过账</option>
            <option value="cancelled">已取消</option>
          </Select>
        }
      >
        {loading ? (
          <Loading />
        ) : list.length === 0 ? (
          <EmptyState>暂无盘点单</EmptyState>
        ) : (
          <>
            <MobileCards>
              {list.map((row) => (
                <MobileCard
                  key={row.id}
                  title={row.code}
                  subtitle={`${formatDateTime(row.createdAt)} · ${row.location || "全仓"}`}
                  badge={
                    <Badge tone={statusTone(row.status)}>
                      {STOCKTAKE_STATUS_LABEL[row.status] ?? row.status}
                    </Badge>
                  }
                  rows={[
                    { label: "明细", value: row.lineCount ?? row.lines?.length ?? "—" },
                    { label: "差异", value: row.diffCount ?? "—" },
                    { label: "过账时间", value: row.postedAt ? formatDateTime(row.postedAt) : "—" },
                    { label: "备注", value: row.remark || "—" },
                  ]}
                  actions={
                    <Button size="sm" onClick={() => openDetail(row.id)}>
                      查看明细
                    </Button>
                  }
                />
              ))}
            </MobileCards>

            <TableDesktop>
              <TableWrap>
                <thead>
                  <tr>
                    <Th>单号</Th>
                    <Th>状态</Th>
                    <Th>库位</Th>
                    <Th className={styles.right}>明细数</Th>
                    <Th className={styles.right}>差异数</Th>
                    <Th>创建时间</Th>
                    <Th>过账时间</Th>
                    <Th>操作</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((row) => (
                    <tr key={row.id}>
                      <Td className={styles.mono}>{row.code}</Td>
                      <Td>
                        <Badge tone={statusTone(row.status)}>
                          {STOCKTAKE_STATUS_LABEL[row.status] ?? row.status}
                        </Badge>
                      </Td>
                      <Td>{row.location || "全仓"}</Td>
                      <Td className={styles.right}>{row.lineCount ?? row.lines?.length ?? "—"}</Td>
                      <Td className={styles.right}>{row.diffCount ?? "—"}</Td>
                      <Td className={styles.nowrap}>{formatDateTime(row.createdAt)}</Td>
                      <Td className={styles.nowrap}>{row.postedAt ? formatDateTime(row.postedAt) : "—"}</Td>
                      <Td>
                        <Button size="sm" onClick={() => openDetail(row.id)}>
                          明细
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </TableDesktop>
          </>
        )}
      </Section>

      {/* 明细抽屉 */}
      <Drawer
        open={detail !== null || detailLoading}
        title={detail ? `盘点单 ${detail.code}` : "盘点单明细"}
        onClose={() => setDetail(null)}
        footer={
          detail ? (
            <div className={styles.actions} style={{ justifyContent: "flex-end" }}>
              <Button onClick={() => setDetail(null)}>关闭</Button>
              <Button
                variant="primary"
                disabled={!canWrite || saving || detail.status === "posted"}
                onClick={() => saveCounts()}
              >
                {saving ? "保存中…" : "保存实盘数"}
              </Button>
              <Button
                variant="danger"
                disabled={!canPost || posting || detail.status === "posted"}
                title={canPost ? undefined : "需要 stocktake:post 权限"}
                onClick={post}
              >
                {posting ? "过账中…" : "过账"}
              </Button>
            </div>
          ) : null
        }
      >
        {detailLoading && !detail ? (
          <Loading />
        ) : detail ? (
          <div className={styles.stack}>
            {!canPost ? <Alert kind="info">当前角色无 stocktake:post 权限，过账按钮已禁用。</Alert> : null}
            {detail.status === "posted" ? (
              <Alert kind="success">该盘点单已过账，明细只读。</Alert>
            ) : null}

            <div className={styles.mobileCardRows}>
              <div className={styles.mobileCardRow}>
                <dt>状态</dt>
                <dd>{STOCKTAKE_STATUS_LABEL[detail.status] ?? detail.status}</dd>
              </div>
              <div className={styles.mobileCardRow}>
                <dt>库位</dt>
                <dd>{detail.location || "全仓"}</dd>
              </div>
              <div className={styles.mobileCardRow}>
                <dt>创建</dt>
                <dd>{formatDateTime(detail.createdAt)}</dd>
              </div>
              <div className={styles.mobileCardRow}>
                <dt>过账</dt>
                <dd>{detail.postedAt ? formatDateTime(detail.postedAt) : "—"}</dd>
              </div>
            </div>

            {(detail.lines ?? []).length === 0 ? (
              <EmptyState>该盘点单没有明细行</EmptyState>
            ) : (
              <div className={styles.stack}>
                {(detail.lines ?? []).map((line) => (
                  <CountLine
                    key={line.id}
                    line={line}
                    value={counts[line.id] ?? ""}
                    disabled={!canWrite || detail.status === "posted"}
                    onChange={(value) => setCounts((prev) => ({ ...prev, [line.id]: value }))}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <EmptyState>未找到盘点单</EmptyState>
        )}
      </Drawer>

      {/* 新建抽屉 */}
      <Drawer
        open={createOpen}
        title="新建盘点单"
        onClose={() => setCreateOpen(false)}
        footer={
          <div className={styles.actions} style={{ justifyContent: "flex-end" }}>
            <Button onClick={() => setCreateOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" onClick={create} disabled={saving || !canWrite}>
              {saving ? "创建中…" : "创建"}
            </Button>
          </div>
        }
      >
        <div className={styles.stack}>
          <Field label="库位" hint="留空表示全仓盘点">
            <Input
              value={createForm.location}
              onChange={(e) => setCreateForm({ ...createForm, location: e.target.value })}
              placeholder="A-01"
            />
          </Field>
          <Field label="备注">
            <Textarea
              rows={2}
              value={createForm.remark}
              onChange={(e) => setCreateForm({ ...createForm, remark: e.target.value })}
            />
          </Field>
        </div>
      </Drawer>
    </>
  );
}

function CountLine({
  line,
  value,
  disabled,
  onChange,
}: {
  line: StocktakeLine;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const counted = value === "" ? null : Number(value);
  const diff =
    counted === null || !Number.isFinite(counted) ? null : counted - (line.bookQty ?? 0);

  return (
    <div className={styles.mobileCard}>
      <div className={styles.mobileCardHead}>
        <div style={{ minWidth: 0 }}>
          <div className={styles.mobileCardTitle}>{line.itemName || line.sku || line.itemId.slice(0, 8)}</div>
          <div className={styles.mobileCardSub}>{line.sku ?? ""}</div>
        </div>
        {diff !== null ? (
          <Badge tone={diff === 0 ? "green" : diff > 0 ? "blue" : "red"}>
            差异 {diff > 0 ? "+" : ""}
            {diff}
          </Badge>
        ) : (
          <Badge tone="slate">未盘</Badge>
        )}
      </div>
      <div className={styles.formGrid} style={{ marginTop: 8 }}>
        <Field label="账面数">
          <Input value={line.bookQty ?? 0} disabled readOnly />
        </Field>
        <Field label="实盘数">
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            placeholder="请输入实盘数量"
          />
        </Field>
      </div>
    </div>
  );
}
