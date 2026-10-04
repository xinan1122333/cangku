"use client";

/**
 * 手机扫码作业页（/scan）。
 * html5-qrcode 动态 import（避免 SSR 报错），优先 facingMode: environment。
 * 非 HTTPS / 摄像头被拒 → 中文提示，并提供手动输入条码兜底。
 * 命中 → 物料卡（名称/SKU/规格/库位/结存）+ 快捷入库/出库 → POST /api/movements。
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { readErrorMessage, request } from "../_components/api";
import type { ItemDto, ScanResolveResult } from "../_components/api";
import { MovementForm } from "../_components/movement-form";
import { useSession } from "../_components/session";
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  Loading,
  PageHeader,
  Section,
  styles,
} from "../_components/ui";

/** html5-qrcode 的最小类型（动态 import，不引入其类型包） */
type Html5QrcodeInstance = {
  start: (
    camera: { facingMode: string } | string,
    config: { fps: number; qrbox?: { width: number; height: number } },
    onSuccess: (decodedText: string) => void,
    onError?: (message: string) => void,
  ) => Promise<void>;
  stop: () => Promise<void>;
  clear: () => void;
};

type ScannerCtor = new (elementId: string) => Html5QrcodeInstance;

type ScanState =
  | {
      kind: "item";
      item: ItemDto;
      onHand: number;
    }
  | {
      kind: "unknown";
      code: string;
    }
  | null;

const READER_ID = "wms-scan-reader";

export default function ScanPage() {
  const { me, can } = useSession();
  const [manualCode, setManualCode] = useState("");
  const [result, setResult] = useState<ScanState>(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cameraState, setCameraState] = useState<"idle" | "starting" | "running" | "denied" | "insecure">(
    "idle",
  );
  const [cameraMessage, setCameraMessage] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [insecureContext, setInsecureContext] = useState(false);

  const scannerRef = useRef<Html5QrcodeInstance | null>(null);
  const lastCodeRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const unmountedRef = useRef(false);
  const canWrite = can("movement:write");
  const canItemWrite = can("item:write");

  // 检测安全上下文：navigator.mediaDevices 在非 HTTPS/非 localhost 下为 undefined
  useEffect(() => {
    if (typeof window === "undefined") return;
    const secure =
      window.isSecureContext === true &&
      typeof navigator !== "undefined" &&
      navigator.mediaDevices !== undefined;
    setInsecureContext(!secure);
    if (!secure) {
      setCameraState("insecure");
      setCameraMessage("当前页面不是安全上下文（HTTPS 或 localhost），浏览器已禁用摄像头。");
    }
  }, []);

  const pushLog = useCallback((text: string) => {
    setLog((prev) => [`${new Date().toLocaleTimeString()} ${text}`, ...prev].slice(0, 20));
  }, []);

  /** 解析条码 */
  const resolve = useCallback(
    async (code: string) => {
      const trimmed = code.trim();
      if (!trimmed) return;
      setResolving(true);
      setError(null);
      setNotice(null);
      try {
        const data = await request<ScanResolveResult>("/api/scan/resolve", { query: { code: trimmed } });
        if (data.kind === "item") {
          setResult({ kind: "item", item: data.item, onHand: data.onHand });
          pushLog(`命中 ${data.item.sku} · 结存 ${data.onHand}`);
        } else {
          setResult({ kind: "unknown", code: trimmed });
          pushLog(`未登记条码 ${trimmed}`);
        }
      } catch (err) {
        setResult(null);
        setError(readErrorMessage(err));
        pushLog(`解析失败：${readErrorMessage(err)}`);
      } finally {
        setResolving(false);
      }
    },
    [pushLog],
  );

  /** 处理一次扫码结果（带去抖，避免同一码连续触发） */
  const handleDecoded = useCallback(
    (code: string) => {
      const now = Date.now();
      if (lastCodeRef.current.code === code && now - lastCodeRef.current.at < 2500) return;
      lastCodeRef.current = { code, at: now };
      void resolve(code);
    },
    [resolve],
  );

  const stopScanner = useCallback(async (keepState = false) => {
    const scanner = scannerRef.current;
    if (scanner) {
      try {
        await scanner.stop();
        scanner.clear();
      } catch {
        // 已停止
      } finally {
        scannerRef.current = null;
      }
    }
    if (!keepState) setCameraState((prev) => (prev === "running" ? "idle" : prev));
  }, []);

  const startScanner = useCallback(async () => {
    if (typeof window === "undefined") return;

    if (window.isSecureContext !== true || typeof navigator === "undefined" || !navigator.mediaDevices) {
      setInsecureContext(true);
      setCameraState("insecure");
      setCameraMessage("手机浏览器要求 HTTPS，请用 https:// 访问（或使用 localhost 调试）。");
      return;
    }

    setCameraState("starting");
    setCameraMessage(null);
    setError(null);

    try {
      // 动态 import，避免 SSR 阶段加载浏览器 API
      const mod = (await import("html5-qrcode")) as unknown as { Html5Qrcode: ScannerCtor };
      const Html5Qrcode = mod.Html5Qrcode;

      // 清理旧实例（不改状态，避免启动过程中闪回 idle）
      await stopScanner(true);

      const scanner = new Html5Qrcode(READER_ID);
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (decodedText) => handleDecoded(decodedText),
        () => {
          // 单帧未识别：忽略
        },
      );

      // 组件已卸载则立刻关掉摄像头，避免「幽灵摄像头」
      if (unmountedRef.current) {
        await stopScanner(true);
        return;
      }

      setCameraState("running");
      pushLog("摄像头已启动（后置 environment）");
    } catch (err) {
      scannerRef.current = null;
      const message = err instanceof Error ? err.message : String(err);
      const denied = /permission|denied|notallowed/i.test(message);
      setCameraState(denied ? "denied" : "idle");
      setCameraMessage(
        denied
          ? "摄像头权限被拒绝。请在浏览器地址栏的站点设置中允许摄像头，然后重试。"
          : "无法启动摄像头，请确认设备有可用摄像头并使用 https:// 访问。",
      );
      pushLog(`摄像头启动失败：${message}`);
    }
  }, [handleDecoded, pushLog, stopScanner]);

  // 离开页面时停止摄像头（含卸载瞬间仍在启动中的情况）
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      const scanner = scannerRef.current;
      if (scanner) {
        void scanner.stop().catch(() => undefined);
        try {
          scanner.clear();
        } catch {
          // 忽略
        }
        scannerRef.current = null;
      }
    };
  }, []);

  async function refreshOnHand() {
    if (result?.kind !== "item") return;
    try {
      const data = await request<ScanResolveResult>("/api/scan/resolve", {
        query: { code: result.item.barcode || result.item.sku },
      });
      if (data.kind === "item") {
        setResult({ kind: "item", item: data.item, onHand: data.onHand });
      }
    } catch {
      // 保留旧结存
    }
  }

  return (
    <>
      <PageHeader
        title="扫码作业"
        description="扫条码 → 查看物料 → 快捷入库/出库"
        actions={
          canItemWrite ? (
            <Link
              href={result?.kind === "unknown" ? `/items?barcode=${encodeURIComponent(result.code)}` : "/items"}
              className={`${styles.btn} ${styles.btnSecondary}`}
            >
              新建物料
            </Link>
          ) : null
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

      <div className={styles.scanLayout}>
        <div className={styles.stack}>
          <Section title="摄像头扫码" description="建议使用手机后置摄像头">
            {insecureContext || cameraState === "insecure" ? (
              <Alert kind="warning">
                手机浏览器要求 HTTPS，请用 https:// 访问。当前地址无法调用摄像头（
                {typeof window !== "undefined" ? window.location.protocol : "非安全上下文"}
                ），可先使用下方「手动输入条码」。
              </Alert>
            ) : null}

            {cameraMessage && cameraState !== "insecure" ? <Alert kind="warning">{cameraMessage}</Alert> : null}
            {cameraState === "denied" ? (
              <Alert kind="error">
                摄像头权限被拒绝：请在浏览器站点设置中允许摄像头权限后重试。
              </Alert>
            ) : null}

            <div className={styles.readerBox}>
              <div id={READER_ID} style={{ width: "100%" }} />
              {cameraState !== "running" ? (
                <div className={styles.readerIdle}>
                  {cameraState === "starting" ? "正在启动摄像头…" : "摄像头未启动"}
                </div>
              ) : null}
            </div>

            <div className={styles.actions} style={{ marginTop: 12 }}>
              {cameraState === "running" ? (
                <Button onClick={() => void stopScanner()}>停止扫码</Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={cameraState === "starting"}
                  onClick={() => void startScanner()}
                >
                  {cameraState === "starting" ? "启动中…" : "启动摄像头"}
                </Button>
              )}
              <Button
                variant="secondary"
                disabled={!manualCode.trim() || resolving}
                onClick={() => void resolve(manualCode)}
              >
                解析上方条码
              </Button>
            </div>
            <p className={styles.hint}>
              部署提示：局域网 http://192.168.x.x 会被浏览器拒绝摄像头，必须使用 HTTPS 或 localhost。
            </p>
          </Section>

          <Section title="手动输入条码" description="扫码不可用时的兜底方式">
            <form
              className={styles.inlineForm}
              onSubmit={(e) => {
                e.preventDefault();
                void resolve(manualCode);
              }}
            >
              <Field label="条码 / SKU" className={styles.flex1}>
                <Input
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  placeholder="6901234567890 或 SKU-0001"
                  inputMode="text"
                  autoComplete="off"
                />
              </Field>
              <Button variant="primary" type="submit" disabled={resolving || !manualCode.trim()}>
                {resolving ? "解析中…" : "查询"}
              </Button>
            </form>
            {log.length > 0 ? (
              <ul className={styles.scanLog}>
                {log.map((entry, index) => (
                  <li key={`${entry}-${index}`}>{entry}</li>
                ))}
              </ul>
            ) : null}
          </Section>
        </div>

        <div className={styles.stack}>
          {resolving ? (
            <Section title="查询结果">
              <Loading label="正在查询物料…" />
            </Section>
          ) : result?.kind === "item" ? (
            <>
              <div className={styles.itemCard}>
                <div className={styles.mobileCardHead}>
                  <div style={{ minWidth: 0 }}>
                    <h2 className={styles.itemCardTitle}>{result.item.name}</h2>
                    <div className={styles.itemCardSku}>
                      {result.item.sku}
                      {result.item.barcode ? ` · ${result.item.barcode}` : ""}
                    </div>
                  </div>
                  <Badge tone={result.item.status === "active" ? "green" : "slate"}>
                    {result.item.status === "active" ? "启用" : "停用"}
                  </Badge>
                </div>

                <dl className={styles.kvGrid}>
                  <div className={styles.kv}>
                    <dt>规格</dt>
                    <dd>{result.item.spec || "—"}</dd>
                  </div>
                  <div className={styles.kv}>
                    <dt>库位</dt>
                    <dd>{result.item.location || "—"}</dd>
                  </div>
                  <div className={styles.kv}>
                    <dt>单位</dt>
                    <dd>{result.item.unit || "—"}</dd>
                  </div>
                  <div className={styles.kv}>
                    <dt>安全库存</dt>
                    <dd>{result.item.safetyStock ?? 0}</dd>
                  </div>
                  <div className={styles.kv}>
                    <dt>当前结存</dt>
                    <dd className={styles.kvHighlight}>
                      {result.onHand} {result.item.unit ?? ""}
                    </dd>
                  </div>
                  <div className={styles.kv}>
                    <dt>分类</dt>
                    <dd>{result.item.category || "—"}</dd>
                  </div>
                </dl>

                {result.onHand <= (result.item.safetyStock ?? 0) ? (
                  <div style={{ marginTop: 12 }}>
                    <Badge tone="red">低于安全库存，建议补货</Badge>
                  </div>
                ) : null}
              </div>

              <Section title="快捷出入库" description="提交后自动刷新结存">
                {!canWrite ? (
                  <Alert kind="warning">当前角色无 movement:write 权限，无法登记出入库。</Alert>
                ) : null}
                <MovementForm
                  key={`${result.item.id}-${result.onHand}`}
                  item={result.item}
                  onHand={result.onHand}
                  disabled={!canWrite}
                  disabledReason="当前角色无 movement:write 权限"
                  onDone={(movement) => {
                    setNotice(
                      `已记录 ${result.item.name} 的${
                        movement.signedQuantity >= 0 ? "入库" : "出库"
                      }，结存 ${movement.afterQty}`,
                    );
                    void refreshOnHand();
                  }}
                />
              </Section>
            </>
          ) : result?.kind === "unknown" ? (
            <Section title="未登记条码">
              <Alert kind="warning">
                条码「{result.code}」未在系统中登记。可以前往物料档案新建物料并预填该条码。
              </Alert>
              <div className={styles.actions}>
                {canItemWrite ? (
                  <Link
                    href={`/items?barcode=${encodeURIComponent(result.code)}`}
                    className={`${styles.btn} ${styles.btnPrimary}`}
                  >
                    + 新建物料（预填条码）
                  </Link>
                ) : (
                  <Button variant="primary" disabled title="需要 item:write 权限">
                    + 新建物料（预填条码）
                  </Button>
                )}
                <Button onClick={() => { setResult(null); setManualCode(""); }}>重新扫描</Button>
              </div>
            </Section>
          ) : (
            <Section title="待扫描">
              <p className={styles.empty}>
                扫描或手动输入条码后，这里会显示物料卡与快捷出入库表单。
              </p>
              {me ? <p className={styles.hint}>当前操作人：{me.displayName}</p> : null}
            </Section>
          )}
        </div>
      </div>
    </>
  );
}
