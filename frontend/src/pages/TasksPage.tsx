import { useState } from 'react';
import { Link } from 'react-router-dom';
import { http } from '../api/client';
import type { CrmTask, PagedResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import {
  Button,
  Empty,
  ErrorMessage,
  Field,
  Loading,
  Modal,
  StatusBadge,
  formatDateTime,
  serverField,
  useAsync,
} from '../components/ui';

/** Мои задачи и задачи заявок в области видимости (RBAC-01, §10.1). */
export function TasksPage() {
  const { user } = useAuth();
  const [scope, setScope] = useState<'mine' | 'overdue' | 'all'>('mine');
  const [status, setStatus] = useState('OPEN');
  const [completeTarget, setCompleteTarget] = useState<CrmTask | null>(null);
  const [result, setResult] = useState('');
  const [cancelTarget, setCancelTarget] = useState<CrmTask | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const tasks = useAsync(
    (signal) => {
      const query = new URLSearchParams({ size: '100' });
      if (scope === 'mine') query.set('assigneeId', user?.id ?? '');
      if (scope === 'overdue') query.set('overdue', 'true');
      if (status) query.set('status', status);
      return http.get<PagedResponse<CrmTask>>(`/tasks?${query.toString()}`, signal);
    },
    [scope, status, user?.id],
  );

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      tasks.reload();
      setCompleteTarget(null);
      setCancelTarget(null);
      setResult('');
      setReason('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="row row--wrap">
        <div>
          <h1>Задачи</h1>
          <div className="subtle">Список ограничен областью видимости: чужие заявки не отображаются</div>
        </div>
        <div className="card__spacer" />
        <div className="row">
          <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} style={{ width: 'auto' }}>
            <option value="mine">Мои задачи</option>
            <option value="overdue">Просроченные</option>
            <option value="all">Все доступные</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
            <option value="OPEN">Открытые</option>
            <option value="DONE">Завершённые</option>
            <option value="CANCELLED">Отменённые</option>
            <option value="">Все</option>
          </select>
        </div>
      </div>

      {error && <ErrorMessage error={error} />}

      {tasks.loading ? (
        <Loading label="Загружаю задачи…" />
      ) : (tasks.data?.items.length ?? 0) === 0 ? (
        <Empty>Задач нет</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Тема</th>
                <th>Тип</th>
                <th>Заявка</th>
                <th>Контрагент</th>
                <th>Исполнитель</th>
                <th>Срок</th>
                <th>Приоритет</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tasks.data!.items.map((task) => (
                <tr key={task.id}>
                  <td>
                    {task.subject}
                    {task.description && <div className="subtle">{task.description}</div>}
                  </td>
                  <td className="subtle">{task.type}</td>
                  <td className="mono">
                    {task.application ? (
                      <Link to={`/applications/${task.application.number}`}>{task.application.number}</Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{task.application?.organization?.name ?? '—'}</td>
                  <td>{task.assignee?.fullName ?? '—'}</td>
                  <td className="nowrap">{formatDateTime(task.dueAt)}</td>
                  <td>
                    <span className={`badge${task.priority === 'CRITICAL' || task.priority === 'HIGH' ? ' badge--danger' : ''}`}>{task.priority}</span>
                  </td>
                  <td>
                    <StatusBadge status={task.status} />
                  </td>
                  <td>
                    {task.status === 'OPEN' && task.assigneeId === user?.id && (
                      <div className="row row--wrap">
                        <Button variant="soft" className="btn--sm" onClick={() => setCompleteTarget(task)}>
                          Завершить
                        </Button>
                        <Button variant="ghost" className="btn--sm" onClick={() => setCancelTarget(task)}>
                          Отменить
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {completeTarget && (
        <Modal
          title="Завершение задачи"
          onClose={() => setCompleteTarget(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCompleteTarget(null)}>
                Отмена
              </Button>
              <Button busy={busy} onClick={() => run(() => http.post(`/tasks/${completeTarget.id}/complete`, { result }))}>
                Завершить
              </Button>
            </>
          }
        >
          <ErrorMessage error={error} />
          <div className="subtle">{completeTarget.subject}</div>
          <Field label="Результат" error={serverField(error, 'result')}>
            <textarea value={result} onChange={(e) => setResult(e.target.value)} />
          </Field>
        </Modal>
      )}

      {cancelTarget && (
        <Modal
          title="Отмена задачи"
          onClose={() => setCancelTarget(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCancelTarget(null)}>
                Отмена
              </Button>
              <Button variant="danger" busy={busy} onClick={() => run(() => http.post(`/tasks/${cancelTarget.id}/cancel`, { reason }))}>
                Отменить задачу
              </Button>
            </>
          }
        >
          <ErrorMessage error={error} />
          <Field label="Причина отмены" error={serverField(error, 'reason')}>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="subtle">Отмена фиксирует причину; следующее действие по заявке пересчитывается.</div>
        </Modal>
      )}
    </>
  );
}