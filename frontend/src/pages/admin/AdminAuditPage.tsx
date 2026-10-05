import { useState } from 'react';
import { http } from '../../api/client';
import type { AuditEvent } from '../../api/types';
import { Empty, ErrorMessage, Loading, formatDateTime, useAsync } from '../../components/ui';

/** Аудит действий: чтение доступно администратору и по карточке заявки. */
export function AdminAuditPage() {
  const [query, setQuery] = useState('');
  const [entityType, setEntityType] = useState('');
  const events = useAsync(
    (signal) => {
      const params = new URLSearchParams({ size: '100' });
      if (query) params.set('applicationNumber', query);
      if (entityType) params.set('entityType', entityType);
      return http.get<{ items: AuditEvent[]; total: number }>(`/audit-events?${params.toString()}`, signal);
    },
    [query, entityType],
  );

  return (
    <>
      <div className="row row--wrap">
        <div>
          <h1>Аудит</h1>
          <div className="subtle">Каждое значимое действие фиксируется с автором, временем и причиной</div>
        </div>
        <div className="card__spacer" />
        <input placeholder="Номер заявки" value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 220 }} />
        <select value={entityType} onChange={(e) => setEntityType(e.target.value)} style={{ width: 'auto' }}>
          <option value="">Все сущности</option>
          <option value="Application">Заявки</option>
          <option value="CrmQuote">КП</option>
          <option value="CrmTask">Задачи</option>
          <option value="EngTask">Инженерные задания</option>
          <option value="CommercialTerms">Условия</option>
          <option value="ClosingDocument">Закрывающие документы</option>
        </select>
      </div>

      {events.error && <ErrorMessage error={events.error} />}

      {events.loading ? (
        <Loading />
      ) : (events.data?.items.length ?? 0) === 0 ? (
        <Empty>Событий не найдено</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Время</th>
                <th>Действие</th>
                <th>Сущность</th>
                <th>Заявка</th>
                <th>Исполнитель</th>
                <th>Детали</th>
              </tr>
            </thead>
            <tbody>
              {events.data!.items.map((event) => (
                <tr key={event.id}>
                  <td className="nowrap">{formatDateTime(event.createdAt)}</td>
                  <td className="mono">{event.actionCode}</td>
                  <td>
                    {event.entityType}
                    <div className="subtle mono">{event.entityId}</div>
                  </td>
                  <td className="mono">{event.applicationId ?? '—'}</td>
                  <td>{event.actorLogin ?? 'система'}</td>
                  <td className="subtle" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {summarize(event)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function summarize(event: AuditEvent): string {
  const parts: string[] = [];
  if (event.userReason) parts.push(`причина: ${event.userReason}`);
  if (event.beforeJson) parts.push(`было: ${event.beforeJson}`);
  if (event.afterJson) parts.push(`стало: ${event.afterJson}`);
  if (event.correlationId) parts.push(`corr: ${event.correlationId}`);
  if (parts.length === 0) return event.payload ?? '—';
  return parts.join(' · ').slice(0, 300);
}