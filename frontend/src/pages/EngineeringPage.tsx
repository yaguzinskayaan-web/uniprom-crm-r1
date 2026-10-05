import { useState } from 'react';
import { Link } from 'react-router-dom';
import { http } from '../api/client';
import type { EngTask, PagedResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Button, Empty, ErrorMessage, Field, Loading, Modal, StatusBadge, formatDate, serverField, useAsync } from '../components/ui';

/** §3.1 очередь конструкторского отдела: руководитель КО назначает исполнителя и утверждает заключение. */
export function EngineeringPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [completeTarget, setCompleteTarget] = useState<EngTask | null>(null);
  const [decision, setDecision] = useState('FEASIBLE');
  const [conditions, setConditions] = useState('');
  const [technicalExecution, setTechnicalExecution] = useState('');
  const [leadTimeDays, setLeadTimeDays] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [assignTarget, setAssignTarget] = useState<EngTask | null>(null);
  const [designers, setDesigners] = useState<{ id: string; fullName: string }[]>([]);
  const [assigneeId, setAssigneeId] = useState('');

  const tasks = useAsync(
    (signal) => {
      const query = new URLSearchParams({ size: '50' });
      if (status) query.set('status', status);
      if (kind) query.set('kind', kind);
      return http.get<PagedResponse<EngTask>>(`/engineering/tasks?${query.toString()}`, signal);
    },
    [status, kind],
  );

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      tasks.reload();
      setCompleteTarget(null);
      setAssignTarget(null);
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
          <h1>Инженерные задания</h1>
          <div className="subtle">Очередь конструкторского отдела по заявкам, направленным в КО</div>
        </div>
        <div className="card__spacer" />
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }}>
          <option value="">Все виды</option>
          <option value="PREQUOTE">Предварительные</option>
          <option value="ORDER_DESIGN">Документация</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
          <option value="">Все статусы</option>
          <option value="NEW">Новые</option>
          <option value="ASSIGNED">Назначены</option>
          <option value="IN_PROGRESS">В работе</option>
          <option value="WAITING_INPUT">Ожидают данных</option>
          <option value="COMPLETED">Завершены</option>
          <option value="CANCELLED">Отменены</option>
        </select>
      </div>

      {error && <ErrorMessage error={error} />}

      {tasks.loading ? (
        <Loading />
      ) : (tasks.data?.items.length ?? 0) === 0 ? (
        <Empty>Заданий нет</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Заявка</th>
                <th>Вид</th>
                <th>Статус</th>
                <th>Приоритет</th>
                <th>Исполнитель</th>
                <th>Срок</th>
                <th>Заключение</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {tasks.data!.items.map((task) => (
                <tr key={task.id}>
                  <td>
                    {task.application ? (
                      <>
                        <Link to={`/applications/${task.application.number}`} className="mono">
                          {task.application.number}
                        </Link>
                        <div className="subtle">{task.application.organization?.name}</div>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="subtle">{task.kind === 'PREQUOTE' ? 'Предварительное' : 'Документация'}</td>
                  <td>
                    <StatusBadge status={task.status} />
                  </td>
                  <td>
                    <span className={`badge${task.priority === 'CRITICAL' ? ' badge--danger' : ''}`}>{task.priority}</span>
                  </td>
                  <td>{task.assignee?.fullName ?? '—'}</td>
                  <td>{formatDate(task.dueAt)}</td>
                  <td>{task.decision ?? '—'}</td>
                  <td>
                    <div className="row row--wrap">
                      {can('eng:assign') && (
                        <Button
                          variant="ghost"
                          className="btn--sm"
                          onClick={async () => {
                            setError(null);
                            try {
                              const list = await http.get<{ id: string; fullName: string; role: string }[]>('/users/assignable');
                              setDesigners(list);
                              setAssigneeId(task.assigneeId ?? list[0]?.id ?? '');
                              setAssignTarget(task);
                            } catch (err) {
                              setError(err);
                            }
                          }}
                        >
                          Назначить
                        </Button>
                      )}
                      {can('eng:work') && task.status !== 'COMPLETED' && (
                        <Button variant="soft" className="btn--sm" onClick={() => setCompleteTarget(task)}>
                          Заключение
                        </Button>
                      )}
                      {can('eng:conclusion:approve') && task.conclusionId && !task.conclusionApprovedAt && (
                        <>
                          <Button variant="soft" className="btn--sm" busy={busy} onClick={() => run(() => http.post(`/engineering/conclusions/${task.conclusionId}/approve`, { approve: true }))}>
                            Утвердить
                          </Button>
                          <Button variant="ghost" className="btn--sm" busy={busy} onClick={() => run(() => http.post(`/engineering/conclusions/${task.conclusionId}/approve`, { approve: false, comment: 'Нужны дополнительные данные' }))}>
                            Отклонить
                          </Button>
                        </>
                      )}
                      {can('eng:work') && task.status !== 'COMPLETED' && task.status !== 'CANCELLED' && (
                        <Button
                          variant="ghost"
                          className="btn--sm"
                          busy={busy}
                          onClick={() => {
                            const reason = window.prompt('Причина отмены задания');
                            if (reason) void run(() => http.post(`/engineering/tasks/${task.id}/cancel`, { reason }));
                          }}
                        >
                          Отменить
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {assignTarget && (
        <Modal
          title="Назначение конструктора"
          onClose={() => setAssignTarget(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAssignTarget(null)}>
                Отмена
              </Button>
              <Button busy={busy} onClick={() => run(() => http.post(`/engineering/tasks/${assignTarget.id}/assign`, { assigneeId }))}>
                Назначить
              </Button>
            </>
          }
        >
          <ErrorMessage error={error} />
          <Field label="Конструктор" error={serverField(error, 'assigneeId')}>
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              {designers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName}
                </option>
              ))}
            </select>
          </Field>
          <div className="subtle">Назначать можно только активного пользователя подходящей роли (RBAC-03).</div>
        </Modal>
      )}

      {completeTarget && (
        <Modal
          title="Техническое заключение"
          onClose={() => setCompleteTarget(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCompleteTarget(null)}>
                Отмена
              </Button>
              <Button
                busy={busy}
                onClick={() =>
                  run(() =>
                    http.post(`/engineering/tasks/${completeTarget.id}/complete`, {
                      decision,
                      conditions: conditions || undefined,
                      technicalExecution: technicalExecution || undefined,
                      leadTimeDays: leadTimeDays ? Number(leadTimeDays) : undefined,
                    }),
                  )
                }
              >
                Сохранить заключение
              </Button>
            </>
          }
        >
          <ErrorMessage error={error} />
          <div className="subtle">
            Заявка: {completeTarget.application?.number} · {completeTarget.application?.organization?.name}
          </div>
          <Field label="Решение" error={serverField(error, 'decision')}>
            <select value={decision} onChange={(e) => setDecision(e.target.value)}>
              <option value="FEASIBLE">Реализуемо</option>
              <option value="FEASIBLE_WITH_CONDITIONS">Реализуемо с условиями</option>
              <option value="NEED_DATA">Требуются данные</option>
              <option value="NOT_FEASIBLE">Нереализуемо</option>
            </select>
          </Field>
          <Field label="Условия">
            <textarea value={conditions} onChange={(e) => setConditions(e.target.value)} />
          </Field>
          <Field label="Техническое исполнение">
            <textarea value={technicalExecution} onChange={(e) => setTechnicalExecution(e.target.value)} />
          </Field>
          <Field label="Срок изготовления, дней">
            <input type="number" min={0} value={leadTimeDays} onChange={(e) => setLeadTimeDays(e.target.value)} />
          </Field>
          <div className="subtle">Утверждает заключение руководитель КО; результат влияет на возможность подготовки КП (ENG-06).</div>
        </Modal>
      )}
    </>
  );
}