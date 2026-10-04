"use client";

/**
 * 用户管理：列表、建用户、分配角色、启用/禁用、重置密码。
 * 契约 §4：GET/POST /api/users，GET/PATCH/DELETE /api/users/[id]。
 */

import { useCallback, useEffect, useState } from "react";
import { ApiError, readErrorMessage, request } from "../../_components/api";
import type { Page, Role, User } from "../../_components/api";
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

type ListShape = User[] | Page<User>;

function toPage(value: ListShape | null): Page<User> {
  if (!value) return { rows: [], total: 0, page: 1, pageSize: PAGE_SIZE };
  if (Array.isArray(value)) return { rows: value, total: value.length, page: 1, pageSize: PAGE_SIZE };
  return value;
}

export default function UsersPage() {
  const { me, can } = useSession();
  const [rows, setRows] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState<User | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState({ username: "", displayName: "", password: "", roleId: "", status: "active" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdForm, setPwdForm] = useState({ oldPassword: "", newPassword: "" });

  const canWrite = can("user:write");
  const canReadRoles = can("role:read");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = toPage(await request<ListShape>("/api/users", { query: { page, pageSize: PAGE_SIZE } }));
      setRows(result.rows ?? []);
      setTotal(result.total ?? 0);
    } catch (err) {
      setError(readErrorMessage(err));
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canReadRoles) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await request<Role[] | { rows: Role[] }>("/api/roles");
        const list = Array.isArray(result) ? result : (result.rows ?? []);
        if (!cancelled) setRoles(list);
      } catch {
        // 无 role:read 时角色下拉不可用，仍可用手填 roleId
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canReadRoles]);

  function openCreate() {
    setEditing(null);
    setForm({
      username: "",
      displayName: "",
      password: "",
      roleId: roles.find((r) => r.code === "viewer")?.id ?? roles[0]?.id ?? "",
      status: "active",
    });
    setFormError(null);
    setDrawerOpen(true);
  }

  function openEdit(user: User) {
    setEditing(user);
    setForm({
      username: user.username ?? "",
      displayName: user.displayName ?? "",
      password: "",
      roleId: user.roleId ?? "",
      status: user.status ?? "active",
    });
    setFormError(null);
    setDrawerOpen(true);
  }

  async function save() {
    setFormError(null);
    if (!form.username.trim()) {
      setFormError("用户名不能为空");
      return;
    }
    if (!editing && form.password.length < 6) {
      setFormError("新建用户必须设置至少 6 位密码");
      return;
    }
    if (!form.roleId) {
      setFormError("请选择角色");
      return;
    }

    const body: Record<string, unknown> = {
      username: form.username.trim(),
      displayName: form.displayName.trim() || form.username.trim(),
      roleId: form.roleId,
      status: form.status,
    };
    if (form.password) body.password = form.password;

    setSaving(true);
    try {
      if (editing) {
        await request(`/api/users/${encodeURIComponent(editing.id)}`, { method: "PATCH", body });
        setNotice(`已更新用户「${body.displayName}」`);
      } else {
        await request("/api/users", { method: "POST", body });
        setNotice(`已创建用户「${body.displayName}」`);
      }
      setDrawerOpen(false);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setFormError(`保存失败：${err.message}（用户名可能已被占用）`);
      } else {
        setFormError(readErrorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(user: User) {
    const nextStatus = user.status === "active" ? "disabled" : "active";
    const label = nextStatus === "active" ? "启用" : "停用";
    if (typeof window !== "undefined" && !window.confirm(`确定${label}用户「${user.displayName}」吗？`)) return;
    setError(null);
    try {
      await request(`/api/users/${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        body: { status: nextStatus },
      });
      setNotice(`已${label}用户「${user.displayName}」`);
      await load();
    } catch (err) {
      setError(readErrorMessage(err));
    }
  }

  async function deleteUser(user: User) {
    if (typeof window !== "undefined" && !window.confirm(`确定删除用户「${user.displayName}」吗？此操作不可恢复。`)) {
      return;
    }
    setError(null);
    try {
      await request(`/api/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      setNotice(`已删除用户「${user.displayName}」`);
      await load();
    } catch (err) {
      setError(readErrorMessage(err));
    }
  }

  async function changeOwnPassword() {
    setFormError(null);
    if (pwdForm.newPassword.length < 6) {
      setFormError("新密码至少 6 位");
      return;
    }
    setSaving(true);
    try {
      await request("/api/me/password", { method: "POST", body: pwdForm });
      setNotice("密码已修改");
      setPwdOpen(false);
      setPwdForm({ oldPassword: "", newPassword: "" });
    } catch (err) {
      setFormError(readErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="用户管理"
        description="创建账号、分配角色、启停用户"
        actions={
          <>
            <Button onClick={() => { setPwdForm({ oldPassword: "", newPassword: "" }); setPwdOpen(true); }}>
              修改我的密码
            </Button>
            <Button
              variant="primary"
              disabled={!canWrite}
              title={canWrite ? undefined : "需要 user:write 权限"}
              onClick={openCreate}
            >
              + 新建用户
            </Button>
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
      {!canWrite ? <Alert kind="info">当前角色无 user:write 权限，编辑与新建按钮已禁用。</Alert> : null}

      <Section>
        {loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState>暂无用户</EmptyState>
        ) : (
          <>
            <MobileCards>
              {rows.map((user) => (
                <MobileCard
                  key={user.id}
                  title={user.displayName}
                  subtitle={user.username}
                  badge={
                    <Badge tone={user.status === "active" ? "green" : "slate"}>
                      {user.status === "active" ? "启用" : "停用"}
                    </Badge>
                  }
                  rows={[
                    { label: "角色", value: user.roleName || user.roleCode || user.roleId },
                    { label: "创建", value: formatDateTime(user.createdAt) },
                  ]}
                  actions={
                    <>
                      <Button size="sm" disabled={!canWrite} onClick={() => openEdit(user)}>
                        编辑
                      </Button>
                      <Button size="sm" disabled={!canWrite} onClick={() => toggleStatus(user)}>
                        {user.status === "active" ? "停用" : "启用"}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={!canWrite || user.id === me?.id}
                        onClick={() => deleteUser(user)}
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
                    <Th>用户名</Th>
                    <Th>显示名</Th>
                    <Th>角色</Th>
                    <Th>状态</Th>
                    <Th>创建时间</Th>
                    <Th>操作</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((user) => (
                    <tr key={user.id}>
                      <Td className={styles.mono}>{user.username}</Td>
                      <Td>{user.displayName}</Td>
                      <Td>{user.roleName || user.roleCode || user.roleId}</Td>
                      <Td>
                        <Badge tone={user.status === "active" ? "green" : "slate"}>
                          {user.status === "active" ? "启用" : "停用"}
                        </Badge>
                      </Td>
                      <Td className={styles.nowrap}>{formatDateTime(user.createdAt)}</Td>
                      <Td>
                        <div className={styles.actions}>
                          <Button size="sm" disabled={!canWrite} onClick={() => openEdit(user)}>
                            编辑
                          </Button>
                          <Button size="sm" disabled={!canWrite} onClick={() => toggleStatus(user)}>
                            {user.status === "active" ? "停用" : "启用"}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={!canWrite || user.id === me?.id}
                            onClick={() => deleteUser(user)}
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

        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
      </Section>

      <Drawer
        open={drawerOpen}
        title={editing ? `编辑用户 · ${editing.displayName}` : "新建用户"}
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
        {!canWrite ? <Alert kind="warning">当前角色无 user:write 权限，无法保存。</Alert> : null}
        {formError ? (
          <Alert kind="error" onClose={() => setFormError(null)}>
            {formError}
          </Alert>
        ) : null}
        <div className={styles.formGrid}>
          <Field label="用户名 *" hint={editing ? "用户名一般不建议修改" : undefined}>
            <Input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="zhangsan"
              autoComplete="off"
            />
          </Field>
          <Field label="显示名 *">
            <Input
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              placeholder="张三"
            />
          </Field>
          <Field label={editing ? "重置密码（留空不改）" : "密码 *"} hint="至少 6 位">
            <Input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="••••••"
              autoComplete="new-password"
            />
          </Field>
          <Field label="角色 *">
            {roles.length > 0 ? (
              <Select value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>
                <option value="">请选择角色…</option>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}（{role.code}）
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                value={form.roleId}
                onChange={(e) => setForm({ ...form, roleId: e.target.value })}
                placeholder="角色 ID（无 role:read 时手填）"
              />
            )}
          </Field>
          <Field label="状态">
            <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="active">启用</option>
              <option value="disabled">停用</option>
            </Select>
          </Field>
        </div>
      </Drawer>

      <Drawer
        open={pwdOpen}
        title="修改我的密码"
        onClose={() => setPwdOpen(false)}
        footer={
          <div className={styles.actions} style={{ justifyContent: "flex-end" }}>
            <Button onClick={() => setPwdOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" onClick={changeOwnPassword} disabled={saving}>
              {saving ? "提交中…" : "确认修改"}
            </Button>
          </div>
        }
      >
        {formError ? (
          <Alert kind="error" onClose={() => setFormError(null)}>
            {formError}
          </Alert>
        ) : null}
        <div className={styles.stack}>
          <Field label="当前密码">
            <Input
              type="password"
              value={pwdForm.oldPassword}
              onChange={(e) => setPwdForm({ ...pwdForm, oldPassword: e.target.value })}
              autoComplete="current-password"
            />
          </Field>
          <Field label="新密码" hint="至少 6 位">
            <Input
              type="password"
              value={pwdForm.newPassword}
              onChange={(e) => setPwdForm({ ...pwdForm, newPassword: e.target.value })}
              autoComplete="new-password"
            />
          </Field>
        </div>
      </Drawer>
    </>
  );
}
