import { http } from '../../api/client';
import { Empty, ErrorMessage, Loading, formatDateTime, useAsync } from '../../components/ui';

interface SlaRule {
  id: string;
  code: string;
  name: string;
  stage: string;
  complexity?: string | null;
  priority?: string | null;
  usesBusinessHours: boolean;
  durationMinutes: number;
  remindBeforeMinutes?: number | null;
  escalationUserId?: string | null;
  pauseOnCustomerWait?: boolean;
  isActive: boolean;
}

interface SlaInstance {
  id: string;
  applicationId: string;
  ruleCode: string;
  status: string;
  stage: string;
  dueAt?: string | null;
  breachedAt?: string | null;
  pausedMs?: number;
  application?: { number?: string; organization?: { name?: string } } | null;
  pauses?: { id: string; reason?: string | null; startedAt?: string; endedAt?: string | null }[];
}

/** §10.2 нормативы сроков: правила и активные экземпляры контроля. */
export function AdminSlaPage() {
  const rules = useAsync((signal) => http.get<SlaRule[]>('/crm/admin/sla-rules', signal), []);
  const instances = useAsync((signal) => http.get<{ items: SlaInstance[]; total: number }>('/sla/instances?size=100', signal), []);

  const ruleList = rules.data ?? [];

  return (
    <>
      <div>
        <h1>Нормативы сроков</h1>
        <div className="subtle">Рабочее время и календарь организации задаются отдельно; пауза не скрывает возникшую ранее просрочку (SLA-03)</div>
      </div>

      {rules.error && <ErrorMessage error={rules.error} />}

      <div className="card">
        <div className="card__head">
          <h2>Правила</h2>
        </div>
        {rules.loading ? (
          <Loading />
        ) : ruleList.length === 0 ? (
          <Empty>Правила не настроены</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Код</th>
                  <th>Название</th>
                  <th>Этап</th>
                  <th>Сложность</th>
                  <th>Приоритет</th>
                  <th>Часы</th>
                  <th className="num">Длительность</th>
                  <th>Пауза</th>
                </tr>
              </thead>
              <tbody>
                {ruleList.map((rule) => (
                  <tr key={rule.id}>
                    <td className="mono">{rule.code}</td>
                    <td>{rule.name}</td>
                    <td className="subtle">{rule.stage}</td>
<td className="subtle">{rule.complexity && rule.complexity !== 'ANY' ? rule.complexity : 'любая'}</td>
                  <td className="subtle">{rule.priority && rule.priority !== 'ANY' ? rule.priority : 'любой'}</td>
                  <td className="subtle">{rule.usesBusinessHours ? 'рабочие' : 'календарные'}</td>
                  <td className="num">{rule.durationMinutes} мин</td>
                  <td>
                    {rule.pauseOnCustomerWait ? <span className="badge badge--success">разрешена</span> : <span className="badge">нет</span>}
                  </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Экземпляры контроля</h2>
        </div>
        {instances.error ? <ErrorMessage error={instances.error} /> : null}
        {instances.loading ? (
          <Loading />
        ) : (instances.data?.items.length ?? 0) === 0 ? (
          <Empty>Активных контролей нет</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Заявка</th>
                  <th>Норматив</th>
                  <th>Срок</th>
                  <th>Статус</th>
                  <th>Просрочка</th>
                  <th>Пауза</th>
                </tr>
              </thead>
              <tbody>
                {instances.data!.items.map((item) => (
                  <tr key={item.id}>
                    <td className="mono">{item.application?.number ?? item.applicationId}</td>
                    <td>
                      {item.ruleCode}
                      <div className="subtle">{item.stage}</div>
                    </td>
                    <td className="nowrap">{formatDateTime(item.dueAt)}</td>
                    <td>
                      <span className={`badge ${item.status === 'BREACHED' ? 'badge--danger' : item.status === 'COMPLETED' ? 'badge--success' : ''}`}>
                        {item.status}
                      </span>
                    </td>
                    <td className="nowrap">{formatDateTime(item.breachedAt)}</td>
                    <td className="subtle">
                      {item.pauses && item.pauses.length > 0 ? `${item.pauses.length} пауз · ${Math.round((item.pausedMs ?? 0) / 60000)} мин` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}