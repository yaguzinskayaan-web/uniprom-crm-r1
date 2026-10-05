import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { http } from '../api/client';
import type { ApplicationListItem, PagedResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useReferences } from '../data/references';
import {
  Button,
  Empty,
  ErrorMessage,
  Field,
  Loading,
  StageBadge,
  downloadCsv,
  formatDate,
  formatDateTime,
  formatMoney,
  useAsync,
} from '../components/ui';

/** Список заявок в области видимости пользователя с фильтрами и выгрузкой (IMP-04). */
export function ApplicationsPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [exportError, setExportError] = useState<unknown>(null);

  const stage = params.get('stage') ?? '';
  const q = params.get('q') ?? '';
  const overdue = params.get('overdue') === 'true';
  const page = Number(params.get('page') ?? '1');

  const { refs } = useReferences();

  const list = useAsync(
    (signal) => {
      const query = new URLSearchParams({ page: String(page), size: '50' });
      if (stage) query.set('stage', stage);
      if (q) query.set('search', q);
      if (overdue) query.set('overdue', 'true');
      return http.get<PagedResponse<ApplicationListItem>>(`/applications?${query.toString()}`, signal);
    },
    [stage, q, overdue, page],
  );

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const stageOptions = refs.stages;
  const total = list.data?.total ?? 0;

  const summary = useMemo(() => {
    const items = list.data?.items ?? [];
    const byCurrency = new Map<string, number>();
    for (const item of items) {
      if (item.isClosed) continue;
      const currency = item.currency ?? '—';
      byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + (item.amount ?? 0));
    }
    return [...byCurrency.entries()];
  }, [list.data]);

  return (
    <>
      <div className="row row--wrap">
        <div>
          <h1>Заявки</h1>
          <div className="subtle">Найдено {total} · валюты не суммируются (§10.3)</div>
        </div>
        <div className="card__spacer" />
        {can('analytics:export') && (
          <Button
            variant="ghost"
            onClick={async () => {
              setExportError(null);
              try {
                await downloadCsv('applications.csv', '/analytics/applications.csv');
              } catch (err) {
                setExportError(err);
              }
            }}
          >
            Выгрузить CSV
          </Button>
        )}
        {can('application:create') && (
          <Link className="btn" to="/applications/new">
            Новая заявка
          </Link>
        )}
      </div>

      {exportError && <ErrorMessage error={exportError} />}
      {list.error && <ErrorMessage error={list.error} />}

      <div className="card">
        <div className="form-grid">
          <Field label="Поиск">
            <input
              defaultValue={q}
              placeholder="Номер, контрагент, контакт"
              onKeyDown={(e) => {
                if (e.key === 'Enter') setParam('q', (e.target as HTMLInputElement).value);
              }}
              onBlur={(e) => setParam('q', e.target.value)}
            />
          </Field>
          <Field label="Этап">
            <select value={stage} onChange={(e) => setParam('stage', e.target.value)}>
              <option value="">Все этапы</option>
              {stageOptions.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Срок">
            <label className="checkbox" style={{ marginTop: 6 }}>
              <input type="checkbox" checked={overdue} onChange={(e) => setParam('overdue', e.target.checked ? 'true' : '')} />
              Только просроченные
            </label>
          </Field>
        </div>
      </div>

      {summary.length > 0 && (
        <div className="row row--wrap">
          <span className="subtle">Сумма открытых заявок:</span>
          {summary.map(([currency, amount]) => (
            <span key={currency} className="badge badge--brand">
              {formatMoney(amount, currency)}
            </span>
          ))}
        </div>
      )}

      {list.loading ? (
        <Loading label="Загружаю заявки…" />
      ) : (list.data?.items.length ?? 0) === 0 ? (
        <Empty>Заявок по указанным условиям нет</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Номер</th>
                <th>Контрагент</th>
                <th>Этап</th>
                <th>Сумма</th>
                <th>Приоритет</th>
                <th>Следующее действие</th>
                <th>Контакт</th>
                <th>Ответственный</th>
                <th>Обновлена</th>
              </tr>
            </thead>
            <tbody>
              {list.data!.items.map((app) => (
                <tr key={app.id} className="table-row--link" onClick={() => navigate(`/applications/${app.number}`)}>
                  <td className="mono">
                    {app.number}
                    {app.isOverdue && (
                      <span className="badge badge--danger" style={{ marginLeft: 6 }}>
                        просрочена
                      </span>
                    )}
                  </td>
                  <td>{app.organization?.name}</td>
                  <td>
                    <StageBadge stage={app.stage} />
                  </td>
                  <td className="num">{formatMoney(app.amount, app.currency)}</td>
                  <td>
                    <span className={`badge${app.priority === 'HIGH' || app.priority === 'CRITICAL' ? ' badge--danger' : ''}`}>{app.priority}</span>
                  </td>
                  <td className="nowrap">{formatDate(app.nextActivityAt)}</td>
                  <td>{app.contact?.fullName ?? '—'}</td>
                  <td>{app.owner?.fullName ?? '—'}</td>
                  <td className="nowrap subtle">{formatDateTime(app.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > 50 && (
        <div className="row">
          <Button variant="ghost" disabled={page <= 1} onClick={() => setParam('page', String(page - 1))}>
            Назад
          </Button>
          <span className="subtle">
            Страница {page} · всего {total}
          </span>
          <Button variant="ghost" disabled={page * 50 >= total} onClick={() => setParam('page', String(page + 1))}>
            Вперёд
          </Button>
        </div>
      )}
    </>
  );
}