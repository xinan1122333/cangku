"use client";

/**
 * 出入库/调整快捷表单（物料页与扫码页共用）。
 * 走契约 §4 的 POST /api/movements。
 */

import { useState } from "react";
import { ApiError, readErrorMessage, request } from "./api";
import type { Item, Movement } from "./api";
import { Alert, Button, Field, Input, Select, Textarea, styles } from "./ui";

export type MovementMode = "in" | "out" | "adjust";

export type MovementFormProps = {
  item: Pick<Item, "id" | "sku" | "name" | "unit">;
  /** 当前结存，用于校验与提示 */
  onHand?: number | null;
  defaultMode?: MovementMode;
  disabled?: boolean;
  disabledReason?: string;
  onDone?: (movement: Movement, mode: MovementMode) => void;
  onCancel?: () => void;
};

type FormState = {
  mode: MovementMode;
  quantity: string;
  targetQty: string;
  refNo: string;
  partner: string;
  reason: string;
  remark: string;
  unitCost: string;
};

const MODE_LABEL: Record<MovementMode, string> = { in: "入库", out: "出库", adjust: "调整" };

export function MovementForm({
  item,
  onHand,
  defaultMode = "in",
  disabled = false,
  disabledReason,
  onDone,
  onCancel,
}: MovementFormProps) {
  const [form, setForm] = useState<FormState>({
    mode: defaultMode,
    quantity: "",
    targetQty: onHand !== undefined && onHand !== null ? String(onHand) : "",
    refNo: "",
    partner: "",
    reason: "",
    remark: "",
    unitCost: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit() {
    setError(null);
    setSuccess(null);

    const body: Record<string, unknown> = { itemId: item.id, type: form.mode };

    if (form.mode === "adjust") {
      const target = Number(form.targetQty);
      if (!Number.isFinite(target) || !Number.isInteger(target) || target < 0) {
        setError("调整后的目标结存必须是不小于 0 的整数");
        return;
      }
      body.targetQty = target;
    } else {
      const qty = Number(form.quantity);
      if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0) {
        setError("数量必须是大于 0 的整数");
        return;
      }
      body.quantity = qty;
    }

    if (form.refNo.trim()) body.refNo = form.refNo.trim();
    if (form.partner.trim()) body.partner = form.partner.trim();
    if (form.reason.trim()) body.reason = form.reason.trim();
    if (form.remark.trim()) body.remark = form.remark.trim();
    if (form.unitCost.trim()) {
      const cost = Number(form.unitCost);
      if (!Number.isFinite(cost) || cost < 0) {
        setError("单位成本（分）必须是不小于 0 的数字");
        return;
      }
      body.unitCost = Math.round(cost);
    }

    setSubmitting(true);
    try {
      const created = await request<Movement>("/api/movements", { method: "POST", body });
      const afterQty = typeof created?.afterQty === "number" ? created.afterQty : undefined;
      setSuccess(
        `${MODE_LABEL[form.mode]}成功${
          afterQty !== undefined ? `，当前结存 ${afterQty} ${item.unit ?? ""}` : ""
        }`,
      );
      setForm((prev) => ({
        ...prev,
        quantity: "",
        refNo: "",
        partner: "",
        reason: "",
        remark: "",
        unitCost: "",
      }));
      onDone?.(created, form.mode);
    } catch (err) {
      if (err instanceof ApiError && err.code === "INSUFFICIENT_STOCK") {
        setError(`结存不足，当前可用 ${onHand ?? "未知"}${item.unit ?? ""}，请减少出库数量。`);
      } else {
        setError(readErrorMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.stack}>
      {disabled && disabledReason ? <Alert kind="warning">{disabledReason}</Alert> : null}
      {error ? (
        <Alert kind="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      ) : null}
      {success ? (
        <Alert kind="success" onClose={() => setSuccess(null)}>
          {success}
        </Alert>
      ) : null}

      <div className={styles.segmented} role="tablist">
        {(["in", "out", "adjust"] as MovementMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={form.mode === mode}
            disabled={disabled}
            onClick={() => update("mode", mode)}
            className={`${styles.segmentBtn} ${form.mode === mode ? styles.segmentBtnActive : ""}`}
          >
            {MODE_LABEL[mode]}
          </button>
        ))}
      </div>

      <div className={styles.formGrid}>
        {form.mode === "adjust" ? (
          <Field label="调整后结存" hint="系统按差值记账（最小单位整数）">
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={form.targetQty}
              disabled={disabled}
              onChange={(e) => update("targetQty", e.target.value)}
              placeholder="例如 12"
            />
          </Field>
        ) : (
          <Field
            label={`数量（${item.unit || "单位"}）`}
            hint={
              onHand !== undefined && onHand !== null
                ? `当前结存 ${onHand}${form.mode === "out" ? "，超出将被拒绝" : ""}`
                : undefined
            }
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={form.quantity}
              disabled={disabled}
              onChange={(e) => update("quantity", e.target.value)}
              placeholder="例如 10"
            />
          </Field>
        )}

        <Field label={form.mode === "out" ? "领用人" : "供应商"}>
          <Input
            value={form.partner}
            disabled={disabled}
            onChange={(e) => update("partner", e.target.value)}
            placeholder={form.mode === "out" ? "例如 张三" : "例如 某某供应链"}
          />
        </Field>

        <Field label="关联单号">
          <Input
            value={form.refNo}
            disabled={disabled}
            onChange={(e) => update("refNo", e.target.value)}
            placeholder="PO-2026-001 / SO-…"
          />
        </Field>

        {form.mode === "in" ? (
          <Field label="单位成本（分）" hint="选填，整数分值">
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={form.unitCost}
              disabled={disabled}
              onChange={(e) => update("unitCost", e.target.value)}
              placeholder="例如 1250"
            />
          </Field>
        ) : (
          <Field label="原因">
            <Input
              value={form.reason}
              disabled={disabled}
              onChange={(e) => update("reason", e.target.value)}
              placeholder="例如 生产领料 / 盘盈盘亏"
            />
          </Field>
        )}
      </div>

      <Field label="备注">
        <Textarea
          rows={2}
          value={form.remark}
          disabled={disabled}
          onChange={(e) => update("remark", e.target.value)}
          placeholder="选填"
        />
      </Field>

      <div className={styles.actions}>
        <Button variant="primary" disabled={disabled || submitting} onClick={submit}>
          {submitting ? "提交中…" : `确认${MODE_LABEL[form.mode]}`}
        </Button>
        {onCancel ? (
          <Button variant="secondary" disabled={submitting} onClick={onCancel}>
            取消
          </Button>
        ) : null}
      </div>

      <p className={styles.muted}>
        物料：{item.name}（{item.sku}）
      </p>
    </div>
  );
}

/** 类型选择器（列表页筛选用） */
export function MovementTypeSelect({
  value,
  onChange,
  includeAdjust = true,
}: {
  value: MovementMode;
  onChange: (mode: MovementMode) => void;
  includeAdjust?: boolean;
}) {
  const modes: MovementMode[] = includeAdjust ? ["in", "out", "adjust"] : ["in", "out"];
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as MovementMode)}>
      {modes.map((mode) => (
        <option key={mode} value={mode}>
          {MODE_LABEL[mode]}
        </option>
      ))}
    </Select>
  );
}
