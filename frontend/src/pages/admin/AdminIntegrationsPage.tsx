import { useState } from 'react';
import { http } from '../../api/client';
import { Button, Empty, ErrorMessage, Loading, formatDateTime, useAsync } from '../../components/ui';

interface OutboxMessage {
  id: string;
  system: string;
  objectType: string;
  extId: string;
  applicationId?: string | null;
  eventType: string;
  payload?: string | null;
  correlationId?: string | null;
  state: string;
  attempts: number;
  nextAttemptAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  deliveredAt?: string | null;
}

type IntegrationStatusResponse = IntegrationStatus | IntegrationStatus[];

interface IntegrationStatus {
  system: string;
  links: { total: number; byState: Record<string, number> };
  lastSyncedAt: string | null;
  lastEventAt: string | null;
  pendingOutbox: number;
  failedOutbox: number;
  inboxPending: number;
  lastError?: { objectType?: string; extId?: string; errorText?: string; createdAt?: string } | null;
}

/** §6 обмен с 1С: состояние каналов, исходящие сообщения и подтверждение доставки. */
export function AdminIntegrationsPage() {
  const status = useAsync((signal) => http.get<IntegrationStatusResponse>('/integrations/status', signal), []);
  const outbox = useAsync((signal) => http.get<{ items: OutboxMessage[]; total: number }>('/integrations/outbox?limit=100', signal), []);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const systems = !status.data ? [] : Array.isArray(status.data) ? status.data : [status.data];

  const confirm = async () => {
    setError(null);
    setBusy(true);
    try {
      await http.post('/integrations/outbox/delivered', { ids: selected, correlationId: `ui-${Date.now()}` });
      setSelected([]);
      outbox.reload();
      status.reload();
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
          <h1>Интеграции</h1>
          <div className="subtle">Счета, оплаты и отгрузки приходят из 1С фактами; CRM не перезаписывает импортированный факт</div>
        </div>
        <div className="card__spacer" />
        <Button variant="ghost" onClick={() => { status.reload(); outbox.reload(); }}>
          Обновить
        </Button>
      </div>

      {error && <ErrorMessage error={error} />}

      {status.loading ? (
        <Loading />
      ) : (
        <div className="grid grid--2">
          {systems.map((item) => (
            <div key={item.system} className="card">
              <div className="card__head">
                <h2>{item.system}</h2>
                <div className="card__spacer" />
                <span className={`badge ${item.failedOutbox > 0 ? 'badge--danger' : 'badge--success'}`}>
                  {item.failedOutbox > 0 ? 'есть ошибки' : 'обмен работает'}
                </span>
              </div>
              <div className="kv">
                <div className="kv__k">Связей</div>
                <div className="kv__v">{item.links.total}</div>
                <div className="kv__k">Состояния связей</div>
                <div className="kv__v">
                  <div className="row row--wrap">
                    {Object.entries(item.links.byState).map(([state, count]) => (
                      <span key={state} className="badge">
                        {state}: {count}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="kv__k">Последний обмен</div>
                <div className="kv__v">{formatDateTime(item.lastSyncedAt)}</div>
                <div className="kv__k">Последнее событие</div>
                <div className="kv__v">{formatDateTime(item.lastEventAt)}</div>
                <div className="kv__k">Ожидает отправки</div>
                <div className="kv__v">
                  {item.pendingOutbox} · ошибок {item.failedOutbox} · входящих {item.inboxPending}
                </div>
              </div>
              {item.lastError && (
                <div className="alert alert--error" style={{ marginTop: 10 }}>
                  {item.lastError.objectType ?? 'СИСТЕМА'}: {item.lastError.errorText ?? 'неизвестная ошибка'}
                  <span className="subtle">{formatDateTime(item.lastError.createdAt)}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card__head">
          <h2>Исходящие сообщения</h2>
          <div className="card__spacer" />
          {selected.length > 0 && (
            <Button busy={busy} onClick={confirm}>
              Подтвердить доставку ({selected.length})
            </Button>
          )}
        </div>
        {outbox.loading ? (
          <Loading />
        ) : (outbox.data?.items.length ?? 0) === 0 ? (
          <Empty>Сообщений нет</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th />
                  <th>Событие</th>
                  <th>Объект</th>
                  <th>Состояние</th>
                  <th className="num">Попыток</th>
                  <th>Создано</th>
                  <th>Ошибка</th>
                </tr>
              </thead>
              <tbody>
                {outbox.data!.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      {item.state !== 'DELIVERED' && (
                        <input
                          type="checkbox"
                          checked={selected.includes(item.id)}
                          onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, item.id] : prev.filter((x) => x !== item.id)))}
                        />
                      )}
                    </td>
                    <td>
                      {item.eventType}
                      <div className="subtle mono">{item.system}</div>
                    </td>
                    <td>
                      {item.objectType}
                      <div className="subtle mono">{item.extId}</div>
                    </td>
                    <td>
                      <span className={`badge ${item.state === 'FAILED' ? 'badge--danger' : item.state === 'DELIVERED' ? 'badge--success' : ''}`}>
                        {item.state}
                      </span>
                    </td>
                    <td className="num">{item.attempts}</td>
                    <td className="nowrap subtle">{formatDateTime(item.createdAt)}</td>
                    <td className="subtle">{item.lastError ?? '—'}</td>
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