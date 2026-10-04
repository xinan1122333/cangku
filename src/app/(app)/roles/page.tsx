"use client";

/**
 * 角色与权限：列表、新建角色、权限码勾选（契约 §3 权限字典）、系统角色禁删。
 * 契约 §4：GET/POST /api/roles，GET/PATCH/DELETE /api/roles/[id]。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, readErrorMessage, request } from "../../_components/api";
import type { Permission, Role } from "../../_components/api";
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
  Section,
  TableDesktop,
  TableWrap,
  Td,
  Textarea,
  Th,
  styles,
} from "../../_components/ui";

/** 契约 §3 权限码字典的兜底清单（后端未提供 /api/roles 的权限字典时使用） */
const FALLBACK_PERMISSIONS: Permission[] = [
  { code: "item:read", name: "查看物料", groupName: "物料" },
  { code: "item:write", name: "维护物料", groupName: "物料" },
  { code: "stock:read", name: "查看结存", groupName: "库存" },
  { code: "stock:write", name: "调整结存", groupName: "库存" },
  { code: "movement:read", name: "查看流水", groupName: "流水" },
  { code: "movement:write", name: "登记出入库", groupName: "流水" },
  { code: "movement:export", name: "导出流水", groupName: "流水" },
  { code: "stocktake:read", name: "查看盘点", groupName: "盘点" },
  { code: "stocktake:write", name: "编辑盘点", groupName: "盘点" },
  { code: "stocktake:post", name: "盘点过账", groupName: "盘点" },
  { code: "user:read", name: "查看用户", groupName: "系统" },
  { code: "user:write", name: "维护用户", groupName: "系统" },
  { code: "role:read", name: "查看角色", groupName: "系统" },
  { code: "role:write", name: "维护角色", groupName: "系统" },
  { code: "audit:read", name: "查看审计", groupName: "系统" },
];

type ListShape = Role[] | { rows: Role[]; permissions?: Permission[] };

export default function RolesPage() {
  const { can } = useSession();
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>(FALLBACK_PERMISSIONS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState<Role | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState({ code: "", name: "", description: "", permissions: [] as string[] });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const canWrite = can("role:write");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await request<ListShape>("/api/roles");
      const list = Array.isArray(result) ? result : (result.rows ?? []);
      const perms = Array.isArray(result) ? undefined : result.permissions;
      setRoles(list);
      if (perms && perms.length > 0) setPermissions(perms);
    } catch (err) {
      setError(readErrorMessage(err));
      setRoles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 权限按分组归并 */
  const grouped = useMemo(() => {
    const map = new Map<string, Permission[]>();
    for (const perm of permissions) {
      const group = perm.groupName ?? "其他";
      const list = map.get(group) ?? [];
      list.push(perm);
      map.set(group, list);
    }
    return Array.from(map.entries());
  }, [permissions]);

  function openCreate() {
    setEditing(null);
    setForm({ code: "", name: "", description: "", permissions: [] });
    setFormError(null);
    setDrawerOpen(true);
  }

  function openEdit(role: Role) {
    setEditing(role);
    setForm({
      code: role.code ?? "",
      name: role.name ?? "",
      description: role.description ?? "",
      permissions: role.permissions ?? [],
    });
    setFormError(null);
    setDrawerOpen(true);
  }

  function togglePermission(code: string) {
    setForm((prev) => ({
      ...prev,
      permissions: prev.permissions.includes(code)
        ? prev.permissions.filter((c) => c !== code)
        : [...prev.permissions, code],
    }));
  }

  async function save() {
    setFormError(null);
    if (!form.name.trim()) {
      setFormError("角色名称不能为空");
      return;
    }
    if (!editing && !form.code.trim()) {
      setFormError("角色编码不能为空（例如 keeper）");
      return;
    }
    if (form.permissions.length === 0) {
      setFormError("请至少勾选一项权限");
      return;
    }

    const body: Record<string, unknown> = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      permissions: form.permissions,
    };
    if (!editing) body.code = form.code.trim();

    setSaving(true);
    try {
      if (editing) {
        await request(`/api/roles/${encodeURIComponent(editing.id)}`, { method: "PATCH", body });
        setNotice(`已更新角色「${body.name}」`);
      } else {
        await request("/api/roles", { method: "POST", body });
        setNotice(`已创建角色「${body.name}」`);
      }
      setDrawerOpen(false);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setFormError(`保存失败：${err.message}（角色编码可能已存在）`);
      } else {
        setFormError(readErrorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  }

  async function removeRole(role: Role) {
    if (typeof window !== "undefined" && !window.confirm(`确定删除角色「${role.name}」吗？`)) return;
    setError(null);
    try {
      await request(`/api/roles/${encodeURIComponent(role.id)}`, { method: "DELETE" });
      setNotice(`已删除角色「${role.name}」`);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(`删除失败：${err.message}（系统角色或仍有用户使用该角色）`);
      } else {
        setError(readErrorMessage(err));
      }
    }
  }

  function isSystemRole(role: Role): boolean {
    return role.isSystem === true;
  }

  return (
    <>
      <PageHeader
        title="角色与权限"
        description="按契约权限码勾选；系统内置角色不可删除"
        actions={
          <Button
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : "需要 role:write 权限"}
            onClick={openCreate}
          >
            + 新建角色
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
      {!canWrite ? <Alert kind="info">当前角色无 role:write 权限，编辑与新建按钮已禁用。</Alert> : null}

      <Section title="角色列表">
        {loading ? (
          <Loading />
        ) : roles.length === 0 ? (
          <EmptyState>暂无角色</EmptyState>
        ) : (
          <>
            <MobileCards>
              {roles.map((role) => (
                <MobileCard
                  key={role.id}
                  title={role.name}
                  subtitle={`${role.code}${role.description ? ` · ${role.description}` : ""}`}
                  badge={
                    isSystemRole(role) ? <Badge tone="blue">系统内置</Badge> : <Badge tone="slate">自定义</Badge>
                  }
                  rows={[{ label: "权限数", value: role.permissions?.length ?? 0 }]}
                  actions={
                    <>
                      <Button size="sm" disabled={!canWrite} onClick={() => openEdit(role)}>
                        编辑权限
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={!canWrite || isSystemRole(role)}
                        title={isSystemRole(role) ? "系统内置角色不可删除" : undefined}
                        onClick={() => removeRole(role)}
                      >
                        删除
                      </Button>
                    </>
                  }
                />
              ))}
            </MobileCards>

            <TableDesktop>
              <TableWrap>
                <thead>
                  <tr>
                    <Th>编码</Th>
                    <Th>名称</Th>
                    <Th>说明</Th>
                    <Th>类型</Th>
                    <Th className={styles.right}>权限数</Th>
                    <Th>操作</Th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map((role) => (
                    <tr key={role.id}>
                      <Td className={styles.mono}>{role.code}</Td>
                      <Td>{role.name}</Td>
                      <Td>{role.description || "—"}</Td>
                      <Td>
                        {isSystemRole(role) ? (
                          <Badge tone="blue">系统内置</Badge>
                        ) : (
                          <Badge tone="slate">自定义</Badge>
                        )}
                      </Td>
                      <Td className={styles.right}>{role.permissions?.length ?? 0}</Td>
                      <Td>
                        <div className={styles.actions}>
                          <Button size="sm" disabled={!canWrite} onClick={() => openEdit(role)}>
                            编辑权限
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={!canWrite || isSystemRole(role)}
                            title={isSystemRole(role) ? "系统内置角色不可删除" : undefined}
                            onClick={() => removeRole(role)}
                          >
                            删除
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </TableDesktop>
          </>
        )}
      </Section>

      <Drawer
        open={drawerOpen}
        title={editing ? `编辑角色 · ${editing.name}` : "新建角色"}
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
        {!canWrite ? <Alert kind="warning">当前角色无 role:write 权限，无法保存。</Alert> : null}
        {formError ? (
          <Alert kind="error" onClose={() => setFormError(null)}>
            {formError}
          </Alert>
        ) : null}

        <div className={styles.stack}>
          <div className={styles.formGrid}>
            <Field label="角色编码 *" hint={editing ? "编码创建后不可修改" : "例如 keeper"}>
              <Input
                value={form.code}
                disabled={editing !== null}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="keeper"
              />
            </Field>
            <Field label="角色名称 *">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="仓管员"
              />
            </Field>
            <div className={styles.span2}>
              <Field label="说明">
                <Textarea
                  rows={2}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </Field>
            </div>
          </div>

          <div>
            <div className={styles.actions} style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <strong style={{ fontSize: 13 }}>权限勾选（已选 {form.permissions.length} 项）</strong>
              <div className={styles.actions}>
                <Button size="sm" onClick={() => setForm({ ...form, permissions: permissions.map((p) => p.code) })}>
                  全选
                </Button>
                <Button size="sm" onClick={() => setForm({ ...form, permissions: [] })}>
                  清空
                </Button>
              </div>
            </div>

            {grouped.map(([group, perms]) => (
              <div key={group} className={styles.permGroup}>
                <h3 className={styles.permGroupTitle}>{group}</h3>
                <div className={styles.permGrid}>
                  {perms.map((perm) => (
                    <Checkbox
                      key={perm.code}
                      label={perm.name ? `${perm.name}（${perm.code}）` : perm.code}
                      checked={form.permissions.includes(perm.code)}
                      onChange={() => togglePermission(perm.code)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Drawer>
    </>
  );
}
