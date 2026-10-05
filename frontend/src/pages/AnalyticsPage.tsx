import { useState } from 'react';
import { http } from '../api/client';
import type { Pipeline, PlanFact } from '../api/types';
import {
  Button,
  Empty,
  ErrorMessage,
  Loading,
  downloadCsv,
  formatMoney,
  stageLabel,
  useAsync,
} from '../components/ui';

/** Часы из API приводит к дням: 0.5 ч показываем как 30 мин, целые — сутки. */
function formatDays(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return '0 дн.';
  if (days < 1) return `${Math.round(days * 24 * 60)} мин`;
  return `${days.toFixed(days < 10 ? 1 : 0)} дн.`;
}

/** §10.2 аналитика: воронка, сроки этапов, план-факт. Валюты не суммируются. */
export function AnalyticsPage() {
  const pipeline = useAsync((signal) => http.get<Pipeline>('/pipeline', signal), []);
  const planFact = useAsync((signal) => http.get<PlanFact>('/analytics/plan-fact', signal), []);
  const [exportError, setExportError] = useState<unknown>(null);

  const totals = pipeline.data?.totals;

  return (
    <>
      <div className="row row--wrap">
        <div>
          <h1>Аналитика</h1>
          <div className="subtle">
            {pipeline.data ? `${pipeline.data.scope === 'OWN_APPS' ? 'Мои заявки' : 'Все заявки'} · период с ${pipeline.data.period.from.slice(0, 10)}` : ''}
          </div>
        </div>
        <div className="card__spacer" />
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
      </div>

      {(pipeline.error || exportError) && <ErrorMessage error={pipeline.error ?? exportError} />}

      {pipeline.loading ? (
        <Loading />
      ) : (
        <>
          <div className="grid grid--3">
            <div className="stat">
              <div className="stat__label">Заявок в периоде</div>
              <div className="stat__value">{totals?.created ?? 0}</div>
              <div className="stat__hint">
                активных {totals?.active ?? 0} · won {totals?.won ?? 0} · lost {totals?.lost ?? 0}
              </div>
            </div>
            {Object.entries(totals?.amountByCurrency ?? {}).map(([currency, amount]) => (
              <div key={currency} className="stat">
                <div className="stat__label">Сумма · {currency}</div>
                <div className="stat__value">{formatMoney(amount, currency)}</div>
                <div className="stat__hint">валюты не суммируются (§10.3)</div>
              </div>
            ))}
          <div className="stat">
              <div className="stat__label">Конверсия в договор</div>
              <div className="stat__value">{(totals?.conversionToContract ?? 0).toFixed(1)} %</div>
            </div>
            <div className="stat">
              <div className="stat__label">Конверсия в выигрыш</div>
              <div className="stat__value">{(totals?.conversionToWon ?? 0).toFixed(1)} %</div>
            </div>
            {Object.entries(pipeline.data?.openQuotes ?? {}).map(([currency, amount]) => (
              <div key={`oq-${currency}`} className="stat">
                <div className="stat__label">Открытые КП · {currency}</div>
                <div className="stat__value">{formatMoney(amount, currency)}</div>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="card__head">
              <h2>Воронка по этапам</h2>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Этап</th>
                    <th className="num">Заявок</th>
                    {Object.keys(totals?.amountByCurrency ?? {}).map((currency) => (
                      <th key={currency} className="num">
                        Сумма {currency}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(pipeline.data?.byStage ?? []).map((stage) => (
                    <tr key={stage.stage}>
                      <td>{stage.label || stageLabel(stage.stage)}</td>
                      <td className="num">{stage.count}</td>
                      {Object.keys(totals?.amountByCurrency ?? {}).map((currency) => (
                        <td key={currency} className="num">
                          {formatMoney(stage.amountByCurrency?.[currency], currency)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid--2">
            <div className="card">
              <div className="card__head">
                <h2>Среднее время на этапах</h2>
              </div>
              {(pipeline.data?.stageDurations.length ?? 0) === 0 ? (
                <Empty>Недостаточно данных</Empty>
              ) : (
                <div className="stack">
                  {pipeline.data!.stageDurations.map((item) => {
                    // API отдаёт длительности в часах; в UI показываем дни.
                    const medianDays = (item.medianHours || 0) / 24;
                    const maxDays = (item.maxHours || 0) / 24;
                    return (
                      <div key={item.stage} className="col">
                        <div className="row">
                          <span className="subtle">{item.label || stageLabel(item.stage)}</span>
                          <div className="card__spacer" />
                          <span className="mono">
                            {formatDays(medianDays)} · макс {formatDays(maxDays)}
                          </span>
                        </div>
                        <div className="subtle">выборок: {item.samples}</div>
                        <div className="progress">
                          <div
                            className="progress__bar"
                            style={{ width: `${Number.isFinite(medianDays) ? Math.min(100, (medianDays / 30) * 100) : 0}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="card">
              <div className="card__head">
                <h2>Причины отказа</h2>
              </div>
              {(pipeline.data?.lossReasons.length ?? 0) === 0 ? (
                <Empty>Отказов нет</Empty>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Причина</th>
                        <th className="num">Заявок</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pipeline.data!.lossReasons.map((item) => (
                        <tr key={item.reason}>
                          <td>{item.label}</td>
                          <td className="num">{item.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <div className="card">
        <div className="card__head">
          <h2>План-факт по исполнению</h2>
        </div>
        {planFact.loading ? (
          <Loading />
        ) : (
          <>
            <div className="grid grid--3">
              <div className="stat">
                <div className="stat__label">Заказано</div>
                <div className="stat__value">{planFact.data?.fulfilment.totalOrdered ?? 0}</div>
              </div>
              <div className="stat">
                <div className="stat__label">Отгружено</div>
                <div className="stat__value">{planFact.data?.fulfilment.totalShipped ?? 0}</div>
                <div className="stat__hint">{planFact.data?.fulfilment.completionPct ?? 0}% исполнения</div>
              </div>
              <div className="stat">
                <div className="stat__label">Осталось</div>
                <div className="stat__value">{planFact.data?.fulfilment.totalRemaining ?? 0}</div>
              </div>
            </div>
            <div className="divider" />
            <div className="row row--wrap">
              <span className="subtle">Выставлено счетов:</span>
              {Object.entries(planFact.data?.finance.invoicedByCurrency ?? {}).map(([currency, amount]) => (
                <span key={currency} className="badge badge--brand">
                  {formatMoney(amount, currency)}
                </span>
              ))}
              <span className="subtle">Оплачено:</span>
              {Object.entries(planFact.data?.finance.paidByCurrency ?? {}).map(([currency, amount]) => (
                <span key={currency} className="badge badge--success">
                  {formatMoney(amount, currency)}
                </span>
              ))}
              {Object.keys(planFact.data?.finance.paidByCurrency ?? {}).length === 0 && (
                <span className="muted">оплат нет</span>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}