import { useState } from 'react';
import { http } from '../../api/client';
import type { AdminUser, Page, Role } from '../../api/types';
import { ROLE_LABELS } from '../../auth/AuthContext';
import { Button, Empty, ErrorMessage, Field, Loading, Modal, formatDateTime, serverField, useAsync } from '../../components/ui';

const ROLES: Role[] = ['ADMIN', 'SALES_MANAGER', 'SALES', 'DESIGN_MANAGER', 'DESIGNER', 'PRODUCTION', 'VIEWER'];

/** Управление пользователями: блокировка, роли, сброс пароля (RBAC-03, SEC-02). */
export function AdminUsersPage() {
  const users = useAsync((signal) => http.get<Page<AdminUser>>('/users', signal), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [blockTarget, setBlockTarget] = useState<AdminUser | null>(null);
  const [reason, setReason] = useState('');
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [login, setLogin] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<Role>('SALES');
  const [email, setEmail] = useState('');

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      users.reload();
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="row row--wrap">
        <div>
          <h1>Пользователи</h1>
          <div className="subtle">Назначать задачи можно только активным пользователям; блокировка снимает доступ</div>
        </div>
        <div className="card__spacer" />
        <Button onClick={() => setCreateOpen(true)}>Создать пользователя</Button>
      </div>

      {error && <ErrorMessage error={error} />}

      {users.loading ? (
        <Loading />
      ) : (users.data?.items.length ?? 0) === 0 ? (
        <Empty>Пользователей нет</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Логин</th>
                <th>ФИО</th>
                <th>Роль</th>
                <th>Область видимости</th>
                <th>Статус</th>
                <th>Последний вход</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {users.data!.items.map((user) => (
                <tr key={user.id}>
                  <td className="mono">{user.login}</td>
                  <td>{user.fullName}</td>
                  <td>{ROLE_LABELS[user.role] ?? user.role}</td>
                  <td className="subtle">{user.scope}</td>
                  <td>
                    {user.isActive ? (
                      <span className="badge badge--success">активен</span>
                    ) : (
                      <span className="badge badge--danger">заблокирован</span>
                    )}
                  </td>
                  <td className="nowrap subtle">{formatDateTime(user.lastLoginAt)}</td>
                  <td>
                    <div className="row row--wrap">
                      <Button variant="ghost" className="btn--sm" onClick={() => setBlockTarget(user)}>
                        {user.isActive ? 'Заблокировать' : 'Разблокировать'}
                      </Button>
                      <Button variant="ghost" className="btn--sm" onClick={() => setResetTarget(user)}>
                        Сбросить пароль
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <Modal
          title="Новый пользователь"
          onClose={() => setCreateOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreateOpen(false)}>
                Отмена
              </Button>
              <Button
                busy={busy}
                onClick={async () => {
                  const ok = await run(() => http.post('/users', { login, fullName, role, email: email || undefined }));
                  if (ok) {
                    setCreateOpen(false);
                    setLogin('');
                    setFullName('');
                    setEmail('');
                  }
                }}
              >
                Создать
              </Button>
            </>
          }
        >
          <ErrorMessage error={error} />
          <Field label="Логин" error={serverField(error, 'login')}>
            <input value={login} onChange={(e) => setLogin(e.target.value)} />
          </Field>
          <Field label="ФИО" error={serverField(error, 'fullName')}>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </Field>
          <Field label="E-mail">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Роль" error={serverField(error, 'role')}>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((value) => (
                <option key={value} value={value}>
                  {ROLE_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          <div className="subtle">Область видимости назначается по роли и не редактируется вручную.</div>
        </Modal>
      )}

      {blockTarget && (
        <Modal
          title={blockTarget.isActive ? 'Блокировка пользователя' : 'Снятие блокировки'}
          onClose={() => setBlockTarget(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setBlockTarget(null)}>
                Отмена
              </Button>
              <Button
                variant="danger"
                busy={busy}
                onClick={async () => {
                  const ok = await run(() =>
                    http.post(`/users/${blockTarget.id}/block`, { blocked: blockTarget.isActive, reason }),
                  );
                  if (ok) setBlockTarget(null);
                }}
              >
                Подтвердить
              </Button>
            </>
          }
        >
          <ErrorMessage error={error} />
          <div className="subtle">
            {blockTarget.fullName} · {ROLE_LABELS[blockTarget.role]}
          </div>
          <Field label="Причина" error={serverField(error, 'reason')}>
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </Modal>
      )}

      {resetTarget && (
        <Modal
          title="Сброс пароля"
          onClose={() => setResetTarget(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setResetTarget(null)}>
                Отмена
              </Button>
              <Button
                busy={busy}
                onClick={async () => {
                  const ok = await run(() => http.post(`/users/${resetTarget.id}/reset-password`, { newPassword }));
                  if (ok) {
                    setResetTarget(null);
                    setNewPassword('');
                  }
                }}
              >
                Установить пароль
              </Button>
            </>
          }
        >
          <ErrorMessage error={error} />
          <Field label="Новый пароль" error={serverField(error, 'newPassword')}>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </Field>
          <div className="subtle">Не менее 8 символов; действие фиксируется в аудите.</div>
        </Modal>
      )}
    </>
  );
}