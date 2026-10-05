import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { http } from '../api/client';
import type { CrmTask, Dashboard, MyWork, Notification, PagedResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import {
  Button,
  Empty,
  ErrorMessage,
  Loading,
  StatusBadge,
  StageBadge,
  formatDateTime,
  formatMoney,
  plural,
  useAsync,
} from '../components/ui';

/** Сколько строк задач показывать в таблицах рабочего стола. */
const TASKS_PREVIEW = 10;

/** §10.3 рабочий стол: нормы сроков, загрузка, платежи и учётные факты. */
export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [notice, setNotice] = useState<string | null>(null);
  const dashboard = useAsync((signal) => http.get<Dashboard>('/dashboard', signal), []);
  const myWork = useAsync((signal) => http.get<MyWork>('/my-work', signal), []);
  const notifications = useAsync((signal) => http.get<{ items: Notification[]; unread: number }>('/crm/notifications?size=6', signal), []);
  // Сводка отдаёт по задачам только счётчики, поэтому списки строк таблицы
  // запрашиваются отдельно. Счётчик и список — один и тот же срез: задачи
  // текущего пользователя в статусе OPEN (так же считает `getDashboard`).
  const myId = user?.id ?? '';
  const todayTasks = useAsync(
    (signal) => http.get<PagedResponse<CrmTask>>(`/tasks?today=true&status=OPEN&assigneeId=${myId}&size=${TASKS_PREVIEW}`, signal),
    [myId],
  );
  const overdueTasksList = useAsync(
    (signal) => http.get<PagedResponse<CrmTask>>(`/tasks?overdue=true&status=OPEN&assigneeId=${myId}&size=${TASKS_PREVIEW}`, signal),
    [myId],
  );

  const reloadAll = () => {
    dashboard.reload();
    myWork.reload();
    notifications.reload();
    todayTasks.reload();
    overdueTasksList.reload();
  };

  const counters = dashboard.data?.counters ?? {};
  const openApplications = counters.activeApplications ?? 0;
  // Счётчики задач лежат в `tasks`, а не в `counters`: раньше значение бралось
  // не оттуда и плитка просрочек всегда показывала 0.
  const overdueTasks = dashboard.data?.tasks.overdue ?? 0;
  const todayTasksCount = dashboard.data?.tasks.today ?? 0;
  const myOpenTasks = counters.myOpenTasks ?? 0;
  const staleApplications = counters.staleApplications ?? 0;

  return (
    <>
      <div className="row row--wrap">
        <div>
          <h1>Рабочий стол</h1>
          <div className="subtle">
            {user?.fullName} · {dashboard.data?.period ? `${formatDateTime(dashboard.data.period.from)} — ${formatDateTime(dashboard.data.period.to)}` : 'текущий период'}
          </div>
        </div>
        <div className="card__spacer" />
        <Link className="btn btn--soft" to="/applications/new">
          Новая заявка
        </Link>
        <Button variant="ghost" onClick={reloadAll}>
          Обновить
        </Button>
      </div>

      {notice && <div className="alert alert--success">{notice}</div>}
      {dashboard.error && <ErrorMessage error={dashboard.error} />}

      {dashboard.loading ? (
        <Loading label="Загружаю сводку…" />
      ) : (
        <>
          <div className="grid grid--4">
            <div className="stat">
              <div className="stat__label">Активные заявки</div>
              <div className="stat__value">{openApplications}</div>
              <div className="stat__hint">в вашей области видимости</div>
            </div>
            <div className="stat">
              <div className="stat__label">Мои открытые задачи</div>
              <div className="stat__value">{myOpenTasks}</div>
              <div className="stat__hint">требуют действия</div>
            </div>
            <div className="stat">
              <div className="stat__label">Просроченные задачи</div>
              <div className="stat__value" style={{ color: overdueTasks > 0 ? 'var(--danger)' : undefined }}>
                {overdueTasks}
              </div>
              <div className="stat__hint">{overdueTasks > 0 ? 'требуют внимания' : 'просрочек нет'}</div>
            </div>
            <div className="stat">
              <div className="stat__label">Без активности</div>
              <div className="stat__value" style={{ color: staleApplications > 0 ? 'var(--warning)' : undefined }}>
                {staleApplications}
              </div>
              <div className="stat__hint">заявок без связи с клиентом</div>
            </div>
          </div>

          <div className="grid grid--2">
            <div className="card">
              <div className="card__head">
                <h2>Согласования КП</h2>
                <div className="card__spacer" />
                <span className="badge">{dashboard.data?.quotes.pendingApproval ?? 0} на согласовании</span>
              </div>
              <div className="subtle">Ожидают решения: {dashboard.data?.quotes.sentAwaitingDecision ?? 0}. Принято:</div>
              <div className="row row--wrap" style={{ marginTop: 8 }}>
                {Object.entries(dashboard.data?.quotes.acceptedAmountByCurrency ?? {}).map(([currency, amount]) => (
                  <span key={currency} className="badge badge--success">
                    {formatMoney(amount, currency)}
                  </span>
                ))}
                {Object.keys(dashboard.data?.quotes.acceptedAmountByCurrency ?? {}).length === 0 && <span className="muted">нет принятых КП</span>}
              </div>
            </div>

            <div className="card">
              <div className="card__head">
                <h2>Ожидаемые поступления</h2>
                <div className="card__spacer" />
                {dashboard.data?.accountingDataAgeMinutes != null && (
                  <span className="badge">{dashboard.data.accountingDataAgeMinutes} мин с обмена 1С</span>
                )}
              </div>
              {dashboard.data?.payments.expected.length ? (
                <div className="stack">
                  {dashboard.data.payments.expected.slice(0, 6).map((item) => (
                    <div key={item.number} className="list-row">
                      <span className="mono">{item.number}</span>
                      <div className="card__spacer" />
                      <span className="subtle nowrap">{formatDateTime(item.dueAt)}</span>
                      <span className="mono">{formatMoney(item.amount, item.currency)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty>Плановых поступлений нет</Empty>
              )}
              {Object.keys(dashboard.data?.payments.outstandingByCurrency ?? {}).length > 0 && (
                <>
                  <div className="divider" />
                  <div className="subtle">Остаток к оплате по валютам</div>
                  <div className="row row--wrap" style={{ marginTop: 6 }}>
                    {Object.entries(dashboard.data?.payments.outstandingByCurrency ?? {}).map(([currency, amount]) => (
                      <span key={currency} className="badge badge--warning">
                        {formatMoney(amount, currency)}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card__head">
              <h2>Задачи на сегодня и просроченные</h2>
              <div className="card__spacer" />
              <Link to="/tasks">Все задачи</Link>
            </div>
            {dashboard.loading ? (
              <Loading />
            ) : (
              <>
                {todayTasks.error && <ErrorMessage error={todayTasks.error} />}
                {overdueTasksList.error && <ErrorMessage error={overdueTasksList.error} />}
                <TaskTable
                  title={`Сегодня (${todayTasksCount})`}
                  tasks={todayTasks.data?.items ?? []}
                  loading={todayTasks.loading}
                  onOpen={(n) => navigate(`/applications/${n}`)}
                />
                <div className="divider" />
                <TaskTable
                  title={`Просроченные (${overdueTasks})`}
                  tasks={overdueTasksList.data?.items ?? []}
                  loading={overdueTasksList.loading}
                  overdue
                  onOpen={(n) => navigate(`/applications/${n}`)}
                />
                {todayTasks.data && todayTasks.data.total > todayTasks.data.items.length && (
                  <div className="subtle" style={{ marginTop: 8 }}>
                    Показаны первые {todayTasks.data.items.length} из {todayTasks.data.total}.{' '}
                    <Link to="/tasks">Все задачи</Link>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="grid grid--2">
            <div className="card">
              <div className="card__head">
                <h2>Моя работа</h2>
                <div className="card__spacer" />
                <span className="badge">{myWork.data?.pendingApprovals ?? 0} согласований</span>
              </div>
              {myWork.loading ? (
                <Loading />
              ) : (myWork.data?.activeApplications.length ?? 0) === 0 ? (
                <Empty>Активных заявок в работе нет</Empty>
              ) : (
                <div className="stack">
                  {myWork.data!.activeApplications.slice(0, 6).map((app) => (
                    <Link key={app.id} to={`/applications/${app.number}`} className="list-row">
                      <span className="mono">{app.number}</span>
                      <StageBadge stage={app.stage} />
                      <span className="subtle">{app.organization?.name}</span>
                      <div className="card__spacer" />
                      <span className="subtle nowrap">{formatDateTime(app.nextActivityAt)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            <div className="card">
              <div className="card__head">
                <h2>Уведомления</h2>
                <div className="card__spacer" />
                {notifications.data && notifications.data.unread > 0 && (
                  <Button
                    variant="ghost"
                    className="btn--sm"
                    onClick={async () => {
                      await http.post('/crm/notifications/read-all');
                      setNotice('Все уведомления отмечены прочитанными');
                      notifications.reload();
                    }}
                  >
                    Отметить всё прочитанным
                  </Button>
                )}
              </div>
              {notifications.loading ? (
                <Loading />
              ) : (notifications.data?.items.length ?? 0) === 0 ? (
                <Empty>Уведомлений нет</Empty>
              ) : (
                <div className="stack">
                  {notifications.data!.items.map((item) => (
                    <button
                      key={item.id}
                      className="list-row"
                      style={{ background: 'none', border: 'none', borderBottom: '1px solid var(--border)', textAlign: 'left', cursor: 'pointer' }}
                      onClick={async () => {
                        await http.post(`/crm/notifications/${item.id}/read`, { read: true });
                        notifications.reload();
                      }}
                    >
                      <span className={item.isRead ? 'muted' : ''} style={{ fontWeight: item.isRead ? 500 : 700 }}>
                        {item.title}
                      </span>
                      {!item.isRead && <span className="badge badge--brand">новое</span>}
                      <div className="card__spacer" />
                      <span className="subtle nowrap">{formatDateTime(item.createdAt)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function TaskTable({
  title,
  tasks,
  overdue,
  loading,
  onOpen,
}: {
  title: string;
  tasks: CrmTask[];
  overdue?: boolean;
  loading?: boolean;
  onOpen: (number: string) => void;
}) {
  if (loading) return <Loading />;
  if (tasks.length === 0) return <div className="subtle">{title}: нет</div>;
  return (
    <div>
      <div className="subtle" style={{ marginBottom: 6 }}>
        {title}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Срок</th>
              <th>Тема</th>
              <th>Заявка</th>
              <th>Контрагент</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id} className="table-row--link" onClick={() => task.application && onOpen(task.application.number)}>
                <td className="nowrap" style={{ color: overdue ? 'var(--danger)' : undefined, fontWeight: overdue ? 700 : 500 }}>
                  {formatDateTime(task.dueAt)}
                </td>
                <td>{task.subject}</td>
                <td className="mono">{task.application?.number ?? '—'}</td>
                <td>{task.application?.organization?.name ?? '—'}</td>
                <td>
                  <StatusBadge status={task.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export { plural };