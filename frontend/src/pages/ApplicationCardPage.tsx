import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { http } from '../api/client';
import type {
  ApplicationDetail,
  CloseCheck,
  Commercial,
  Fulfilment,
  Quote,
  ReleaseCheck,
  ReleaseApproval,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useReferences } from '../data/references';
import {
  ACTIVITY_LABELS,
  Button,
  DOC_TYPE_LABELS,
  Empty,
  ErrorMessage,
  Field,
  Loading,
  Modal,
  StageBadge,
  StatusBadge,
  formatDate,
  formatDateTime,
  formatMoney,
  serverField,
  stageLabel,
  useAsync,
} from '../components/ui';

const TABS = [
  { key: 'overview', label: 'Обзор' },
  { key: 'lines', label: 'Позиции' },
  { key: 'quotes', label: 'Коммерческие предложения' },
  { key: 'commercial', label: 'Условия и договор' },
  { key: 'production', label: 'Производство' },
  { key: 'fulfillment', label: 'Исполнение и закрытие' },
  { key: 'tasks', label: 'Задачи' },
  { key: 'activities', label: 'Коммуникации' },
  { key: 'engineering', label: 'КО' },
  { key: 'history', label: 'История' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

/** Карточка заявки: все действия выполняются через API с проверкой прав на сервере. */
export function ApplicationCardPage() {
  const { number = '' } = useParams();
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const { refs } = useReferences();
  const [tab, setTab] = useState<TabKey>('overview');
  const [actionError, setActionError] = useState<unknown>(null);

  const app = useAsync((signal) => http.get<ApplicationDetail>(`/applications/${number}`, signal), [number]);

  const reload = () => {
    app.reload();
  };

  if (app.loading && !app.data) return <Loading label="Открываю карточку…" />;
  if (app.error) return <ErrorMessage error={app.error} />;
  if (!app.data) return <Empty>Заявка не найдена</Empty>;

  const data = app.data;
  const isOwner = data.ownerId === user?.id;
  const canEdit = can('application:update') || can('application:update:any');

  return (
    <>
      <div className="row row--wrap">
        <Button variant="ghost" onClick={() => navigate(-1)}>
          ← Назад
        </Button>
        <div>
          <h1 className="row" style={{ gap: 10 }}>
            {data.number}
            <StageBadge stage={data.stage} />
            {data.isOverdue && <span className="badge badge--danger">просрочена</span>}
          </h1>
          <div className="subtle">
            {data.organization?.name} · источник {data.source} · обновлена {formatDateTime(data.updatedAt)} · версия {data.versionNo}
          </div>
        </div>
        <div className="card__spacer" />
        <Button variant="ghost" onClick={reload}>
          Обновить
        </Button>
      </div>

      {data.closeReopenedAt && (
        <div className="alert alert--warning">
          Заявка возвращена в исполнение {formatDateTime(data.closeReopenedAt)} после корректировки учётных данных: {data.closeReopenReason}. Факт первоначального
          закрытия ({formatDateTime(data.closedAt)}) сохранён.
        </div>
      )}
      {actionError && <ErrorMessage error={actionError} />}

      <div className="tabs">
        {TABS.map((item) => (
          <button key={item.key} className={`tab${tab === item.key ? ' tab--active' : ''}`} onClick={() => setTab(item.key)}>
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab data={data} refs={refs} canEdit={canEdit} isOwner={isOwner} onDone={reload} onError={setActionError} />}
      {tab === 'lines' && <LinesTab data={data} canEdit={canEdit} onDone={reload} />}
      {tab === 'quotes' && <QuotesTab data={data} onDone={reload} />}
      {tab === 'commercial' && <CommercialTab data={data} onDone={reload} />}
      {tab === 'production' && <ProductionTab data={data} onDone={reload} />}
      {tab === 'fulfillment' && <FulfilmentTab data={data} onDone={reload} />}
      {tab === 'tasks' && <TasksTab number={number} data={data} onDone={reload} />}
      {tab === 'activities' && <ActivitiesTab number={number} data={data} onDone={reload} />}
      {tab === 'engineering' && <EngineeringTab data={data} onDone={reload} />}
      {tab === 'history' && <HistoryTab number={number} />}
    </>
  );
}

// ── Обзор ────────────────────────────────────────────────────────────────

function OverviewTab({
  data,
  refs,
  canEdit,
  isOwner,
  onDone,
  onError,
}: {
  data: ApplicationDetail;
  refs: ReturnType<typeof useReferences>['refs'];
  canEdit: boolean;
  isOwner: boolean;
  onDone: () => void;
  onError: (err: unknown) => void;
}) {
  const { can, user } = useAuth();
  const [stageModal, setStageModal] = useState(false);
  const [targetStage, setTargetStage] = useState('');
  const [lossReason, setLossReason] = useState('');
  const [lossComment, setLossComment] = useState('');
  const [complexity, setComplexity] = useState<string>(data.complexity ?? 'NEEDS_CLASSIFICATION');
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignable, setAssignable] = useState<{ id: string; fullName: string; role: string }[]>([]);
  const [ownerId, setOwnerId] = useState<string>(data.ownerId ?? '');
  const [moveTasks, setMoveTasks] = useState(false);

  const assigned = assignable.find((u) => u.id === ownerId);

  return (
    <div className="grid grid--2">
      <div className="card">
        <div className="card__head">
          <h2>Контрагент и контакт</h2>
        </div>
        <div className="kv">
          <div className="kv__k">Организация</div>
          <div className="kv__v">
            {data.organization?.name}
            {data.organization?.inn && <div className="subtle">ИНН {data.organization.inn}</div>}
          </div>
          <div className="kv__k">Контакт</div>
          <div className="kv__v">
            {data.contact?.fullName ?? '—'}
            <div className="subtle">
              {[data.contact?.phone, data.contact?.email].filter(Boolean).join(' · ') || 'контакт не указан'}
            </div>
          </div>
          <div className="kv__k">Ответственный</div>
          <div className="kv__v">
            {data.owner?.fullName ?? '—'}
            {can('application:assign') && (
              <Button
                variant="ghost"
                className="btn--sm"
                onClick={async () => {
                  onError(null);
                  try {
                    setAssignable(await http.get<{ id: string; fullName: string; role: string }[]>('/users/assignable'));
                    setAssignOpen(true);
                  } catch (err) {
                    onError(err);
                  }
                }}
              >
                Переназначить
              </Button>
            )}
          </div>
          <div className="kv__k">Источник</div>
          <div className="kv__v">{data.source}</div>
          <div className="kv__k">Приоритет</div>
          <div className="kv__v">
            <span className={`badge${data.priority === 'HIGH' || data.priority === 'CRITICAL' ? ' badge--danger' : ''}`}>{data.priority}</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Коммерческая сводка</h2>
        </div>
        <div className="kv">
          <div className="kv__k">Сумма</div>
          <div className="kv__v mono">{formatMoney(data.amount, data.currency)}</div>
          <div className="kv__k">Вероятность</div>
          <div className="kv__v">{data.successProbability != null ? `${data.successProbability}%` : '—'}</div>
          <div className="kv__k">Ожидаемое решение</div>
          <div className="kv__v">{formatDate(data.expectedDecisionDate)}</div>
          <div className="kv__k">Сложность</div>
          <div className="kv__v">{complexityLabel(complexityLabelOf(data.complexity))}</div>
          <div className="kv__k">Последняя активность</div>
          <div className="kv__v">{formatDateTime(data.lastActivityAt)}</div>
          <div className="kv__k">Последний контакт</div>
          <div className="kv__v">{formatDateTime(data.lastCustomerContactAt)}</div>
          <div className="kv__k">Следующее действие</div>
          <div className="kv__v">{formatDateTime(data.nextActivityAt)}</div>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Управление заявкой</h2>
        </div>
        <div className="row row--wrap">
          {canEdit && (
            <Button
              onClick={() => {
                setTargetStage(nextStages(data.stage, refs.stages.map((s) => s.value)).map((v) => ({ value: v, label: stageLabel(v) }))[0]?.value ?? '');
                setStageModal(true);
              }}
            >
              Сменить этап
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={async () => {
              onError(null);
              try {
                await http.post(`/applications/${data.number}/complexity`, { complexity });
                onDone();
              } catch (err) {
                onError(err);
              }
            }}
          >
            Сохранить сложность
          </Button>
          <select value={complexity} onChange={(e) => setComplexity(e.target.value)} style={{ width: 'auto' }}>
            {refs.complexity.map((c) => (
              <option key={c.value} value={c.value ?? ''}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="divider" />
        <div className="subtle">Действия доступны по роли; скрытие кнопок не заменяет проверку прав на сервере (RBAC-01).</div>
        {isOwner && <div className="subtle">Вы ответственный по заявке.</div>}
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Комментарий и метки</h2>
        </div>
        <CommentEditor data={data} canEdit={canEdit} onDone={onDone} onError={onError} />
      </div>

      {stageModal && (
        <Modal
          title="Смена этапа"
          onClose={() => setStageModal(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setStageModal(false)}>
                Отмена
              </Button>
              <Button
                busy={false}
                onClick={async () => {
                  onError(null);
                  try {
                    await http.post(`/applications/${data.number}/stage`, {
                      to: targetStage,
                      ...(lossReason ? { lossReason } : {}),
                      ...(lossComment ? { lossComment } : {}),
                    });
                    setStageModal(false);
                    onDone();
                  } catch (err) {
                    onError(err);
                  }
                }}
              >
                Перейти
              </Button>
            </>
          }
        >
          <Field label="Новый этап" error={serverErrorField(onError)}>
            <select value={targetStage} onChange={(e) => setTargetStage(e.target.value)}>
              <option value="">Выберите этап</option>
              {nextStages(data.stage, refs.stages.map((s) => s.value)).map((value) => (
                <option key={value} value={value}>
                  {stageLabel(value)}
                </option>
              ))}
            </select>
          </Field>
          {targetStage === 'CANCELLED' && (
            <>
              <Field label="Причина отказа">
                <select value={lossReason} onChange={(e) => setLossReason(e.target.value)}>
                  <option value="">Выберите причину</option>
                  {refs.lossReasons.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Комментарий">
                <textarea value={lossComment} onChange={(e) => setLossComment(e.target.value)} />
              </Field>
            </>
          )}
        </Modal>
      )}

      {assignOpen && (
        <Modal
          title="Переназначение заявки"
          onClose={() => setAssignOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAssignOpen(false)}>
                Отмена
              </Button>
              <Button
                onClick={async () => {
                  onError(null);
                  try {
                    await http.post(`/applications/${data.number}/assign`, { ownerId: ownerId || null, moveOpenTasks: moveTasks });
                    setAssignOpen(false);
                    onDone();
                  } catch (err) {
                    onError(err);
                  }
                }}
              >
                Передать заявку
              </Button>
            </>
          }
        >
          <Field label="Новый ответственный">
            <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">Оставить в очереди</option>
              {assignable.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName} · {u.role}
                </option>
              ))}
            </select>
          </Field>
          {assigned && assigned.id !== user?.id && (
            <label className="checkbox">
              <input type="checkbox" checked={moveTasks} onChange={(e) => setMoveTasks(e.target.checked)} />
              Перенести открытые задачи на нового ответственного
            </label>
          )}
          <div className="subtle">Назначать можно только активного сотрудника продаж (RBAC-03).</div>
        </Modal>
      )}
    </div>
  );
}

function CommentEditor({ data, canEdit, onDone, onError }: { data: ApplicationDetail; canEdit: boolean; onDone: () => void; onError: (e: unknown) => void }) {
  const [value, setValue] = useState(data.crmComment ?? '');
  const dirty = value !== (data.crmComment ?? '');

  return (
    <>
      <textarea value={value} onChange={(e) => setValue(e.target.value)} disabled={!canEdit} />
      {dirty && canEdit && (
        <div className="row">
          <Button
            onClick={async () => {
              onError(null);
              try {
                await http.patch(`/applications/${data.number}`, { lockVersion: data.lockVersion, crmComment: value });
                onDone();
              } catch (err) {
                onError(err);
              }
            }}
          >
            Сохранить комментарий
          </Button>
          <Button variant="ghost" onClick={() => setValue(data.crmComment ?? '')}>
            Отмена
          </Button>
        </div>
      )}
      {data.tags && data.tags.length > 0 && (
        <div className="row row--wrap" style={{ marginTop: 8 }}>
          {data.tags.map((tag) => (
            <span key={tag} className="badge">
              {tag}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

// ── Позиции ──────────────────────────────────────────────────────────────

function LinesTab({ data, canEdit, onDone }: { data: ApplicationDetail; canEdit: boolean; onDone: () => void }) {
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<ApplicationDetail['lines'][number] | null>(null);
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');

  const save = async () => {
    if (!editing) return;
    setError(null);
    try {
      await http.patch(`/applications/${data.number}`, {
        lockVersion: data.lockVersion,
        lines: [{ lineId: editing.lineId, quantity: Number(qty), price: Number(price) }],
      });
      setEditing(null);
      onDone();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="stack">
      <ErrorMessage error={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Позиция</th>
              <th>Артикул</th>
              <th className="num">Количество</th>
              <th className="num">Отгружено</th>
              <th className="num">Остаток</th>
              <th className="num">Цена</th>
              <th>Сложность</th>
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {data.lines.map((line) => {
              const remaining = (line.orderQty ?? line.quantity) - line.shippedQty;
              return (
                <tr key={line.id}>
                  <td>{line.name}</td>
                  <td className="subtle">{line.catalogRef ?? '—'}</td>
                  <td className="num">
                    {line.quantity} {line.unit}
                  </td>
                  <td className="num">{line.shippedQty}</td>
                  <td className="num" style={{ color: remaining < 0 ? 'var(--danger)' : undefined, fontWeight: 700 }}>
                    {remaining}
                  </td>
                  <td className="num">{formatMoney(line.price, line.currency)}</td>
                  <td>{complexityLabel(complexityLabelOf(line.complexity))}</td>
                  {canEdit && (
                    <td>
                      <Button
                        variant="ghost"
                        className="btn--sm"
                        onClick={() => {
                          setEditing(line);
                          setQty(String(line.quantity));
                          setPrice(String(line.price ?? 0));
                        }}
                      >
                        Изменить
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <Modal
          title={`Изменение позиции «${editing.name}»`}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Отмена
              </Button>
              <Button onClick={save}>Сохранить</Button>
            </>
          }
        >
          <ErrorMessage error={error} />
          <Field label="Количество">
            <input type="number" min={0} step="0.001" value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
          <Field label="Цена">
            <input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
        </Modal>
      )}
    </div>
  );
}

// ── КП ───────────────────────────────────────────────────────────────────

function QuotesTab({ data, onDone }: { data: ApplicationDetail; onDone: () => void }) {
  const { can } = useAuth();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // A40: при отклонении КП комментарий обязателен по ТЗ, а не подставляется по умолчанию
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectComment, setRejectComment] = useState('');
  const quotes = data.quotes ?? [];

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <ErrorMessage error={error} />
      <div className="row row--wrap">
        {can('quote:create') && (
          <Button busy={busy} onClick={() => act(() => http.post(`/applications/${data.number}/quotes`, {}))}>
            Создать КП
          </Button>
        )}
        <span className="subtle">
          Согласование КП — отдельное действие пользователя с полномочием руководителя продаж (RBAC-04).
        </span>
      </div>

      {quotes.length === 0 ? (
        <Empty>Коммерческие предложения не созданы</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Версия</th>
                <th>Статус</th>
                <th>Сумма</th>
                <th>Действует до</th>
                <th>Срок производства</th>
                <th>Решение клиента</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((quote) => (
                <tr key={quote.id}>
                  <td className="mono">v{quote.versionNo}</td>
                  <td>
                    <StatusBadge status={quote.status} />
                    {quote.approvalStatus && (
                      <span className="badge" style={{ marginLeft: 4 }}>
                        согласование: {quote.approvalStatus}
                      </span>
                    )}
                  </td>
                  <td className="num">{formatMoney(quote.amount, quote.currency)}</td>
                  <td>{formatDate(quote.validUntil)}</td>
                  <td>{quote.leadTimeDays != null ? `${quote.leadTimeDays} дн.` : '—'}</td>
                  <td>{quote.customerDecision ?? '—'}</td>
                  <td>
                    <div className="row row--wrap">
                      {quote.status === 'DRAFT' && can('quote:update:draft') && (
                        <Button
                          variant="ghost"
                          className="btn--sm"
                          busy={busy}
                          onClick={() => act(() => http.post(`/quotes/${quote.id}/generate`))}
                        >
                          Сформировать файл
                        </Button>
                      )}
                      {quote.status === 'GENERATED' && can('quote:update:draft') && (
                        <Button
                          variant="ghost"
                          className="btn--sm"
                          busy={busy}
                          onClick={() => act(() => http.post(`/quotes/${quote.id}/submit-approval`))}
                        >
                          На согласование
                        </Button>
                      )}
                      {quote.approvalStatus === 'PENDING' && can('quote:approve') && (
                        <>
                          <Button
                            variant="soft"
                            className="btn--sm"
                            busy={busy}
                            onClick={() => act(() => http.post(`/quotes/${quote.id}/approval-decision`, { decision: 'APPROVED' }))}
                          >
                            Согласовать
                          </Button>
                          <Button
                            variant="ghost"
                            className="btn--sm"
                            busy={busy}
                            onClick={() => {
                              setRejectFor(quote.id);
                              setRejectComment('');
                            }}
                          >
                            Отклонить
                          </Button>
                        </>
                      )}
                      {rejectFor === quote.id && (
                        <div className="row row--wrap reject-box">
                          <textarea
                            className="reject-box__field"
                            value={rejectComment}
                            onChange={(e) => setRejectComment(e.target.value)}
                            placeholder="Укажите причину отклонения"
                            aria-label="Причина отклонения КП"
                          />
                          <Button
                            variant="soft"
                            className="btn--sm"
                            busy={busy}
                            disabled={rejectComment.trim().length === 0}
                            onClick={() =>
                              act(async () => {
                                await http.post(`/quotes/${quote.id}/approval-decision`, {
                                  decision: 'REJECTED',
                                  comment: rejectComment.trim(),
                                });
                                setRejectFor(null);
                                setRejectComment('');
                              })
                            }
                          >
                            Отклонить с комментарием
                          </Button>
                          <Button variant="ghost" className="btn--sm" onClick={() => setRejectFor(null)}>
                            Отмена
                          </Button>
                        </div>
                      )}
                      {quote.status === 'APPROVED' && can('quote:send') && (
                        <Button
                          variant="soft"
                          className="btn--sm"
                          busy={busy}
                          onClick={() =>
                            act(() =>
                              http.post(`/quotes/${quote.id}/send`, {
                                recipients: data.contact?.email ? [data.contact.email] : [],
                                subject: `Коммерческое предложение ${data.number}`,
                              }),
                            )
                          }
                        >
                          Отправить
                        </Button>
                      )}
                      {quote.status === 'SENT' && (
                        <Button
                          variant="ghost"
                          className="btn--sm"
                          busy={busy}
                          onClick={() => act(() => http.post(`/quotes/${quote.id}/customer-decision`, { decision: 'ACCEPTED' }))}
                        >
                          Клиент принял
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
    </div>
  );
}

// ── Условия, договор, выпуск ─────────────────────────────────────────────

function CommercialTab({ data, onDone }: { data: ApplicationDetail; onDone: () => void }) {
  const { can } = useAuth();
  const commercial = data.commercial ?? null;
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [contractNumber, setContractNumber] = useState(commercial?.contractNumber ?? '');
  const [contractDate, setContractDate] = useState(commercial?.contractDate?.slice(0, 10) ?? '');
  const [paymentTerms, setPaymentTerms] = useState(commercial?.paymentTerms ?? '');
  const [deliveryTerms, setDeliveryTerms] = useState(commercial?.deliveryTerms ?? '');
  const [specificationRef, setSpecificationRef] = useState(commercial?.specificationRef ?? '');

  const release = useAsync((signal) => http.get<ReleaseCheck>(`/applications/${data.number}/release-check`, signal), [data.number]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      onDone();
      release.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const check = release.data;
  const canRelease = check?.can_release_to_production ?? false;

  return (
    <div className="grid grid--2">
      <div className="card">
        <div className="card__head">
          <h2>Коммерческие условия</h2>
          <div className="card__spacer" />
          <span className="badge">версия {commercial?.versionNo ?? 1}</span>
        </div>
        <ErrorMessage error={error} />
        <div className="form-grid">
          <Field label="Номер договора">
            <input value={contractNumber} onChange={(e) => setContractNumber(e.target.value)} disabled={!can('commercial:write')} />
          </Field>
          <Field label="Дата договора">
            <input type="date" value={contractDate} onChange={(e) => setContractDate(e.target.value)} disabled={!can('commercial:write')} />
          </Field>
          <Field label="Спецификация">
            <input value={specificationRef} onChange={(e) => setSpecificationRef(e.target.value)} disabled={!can('commercial:write')} />
          </Field>
          <Field label="Условия оплаты">
            <input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} disabled={!can('commercial:write')} />
          </Field>
          <Field label="Условия поставки">
            <input value={deliveryTerms} onChange={(e) => setDeliveryTerms(e.target.value)} disabled={!can('commercial:write')} />
          </Field>
        </div>
        {can('commercial:write') && (
          <div className="form-actions">
            <Button
              busy={busy}
              onClick={() =>
                run(() =>
                  http.patch(`/applications/${data.number}/commercial`, {
                    lockVersion: commercial?.lockVersion ?? 1,
                    contractNumber: contractNumber || null,
                    contractDate: contractDate || null,
                    specificationRef: specificationRef || null,
                    paymentTerms: paymentTerms || null,
                    deliveryTerms: deliveryTerms || null,
                  }),
                )
              }
            >
              Сохранить условия
            </Button>
          </div>
        )}
        {commercial && (
          <div className="kv" style={{ marginTop: 12 }}>
            <div className="kv__k">Статус договора</div>
            <div className="kv__v">
              <StatusBadge status={commercial.contractStatus} />
            </div>
            <div className="kv__k">Основание (КП)</div>
            <div className="kv__v">
              {commercial.basisQuoteId ? formatMoney(commercial.basisAmount, commercial.basisCurrency) : 'не связано'}
            </div>
            <div className="kv__k">Синхронизация 1С</div>
            <div className="kv__v">{commercial.syncedTo1C ? 'передано' : 'ожидает обмена'}</div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Выпуск в производство</h2>
          <div className="card__spacer" />
          {can('release:check') && (
            <Button variant="ghost" className="btn--sm" busy={busy} onClick={() => release.reload()}>
              Проверить условия
            </Button>
          )}
        </div>
        <ErrorMessage error={error} />

        {commercial?.invoices && commercial.invoices.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div className="subtle">Счета из 1С</div>
            <div className="table-wrap" style={{ marginTop: 6 }}>
              <table>
                <thead>
                  <tr>
                    <th>Номер</th>
                    <th>Дата</th>
                    <th className="num">Сумма</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {commercial.invoices.map((invoice) => (
                    <tr key={invoice.id}>
                      <td>{invoice.number ?? invoice.extId}</td>
                      <td>{formatDate(invoice.docDate)}</td>
                      <td className="num">{formatMoney(invoice.amount, invoice.currency)}</td>
                      <td>
                        <StatusBadge status={invoice.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {release.loading && <Loading label="Проверяю условия выпуска…" />}
        {check && (
          <>
            <div className={`alert alert--${canRelease ? 'success' : 'warning'}`}>
              {canRelease ? 'Все условия выпуска выполнены' : 'Выпуск заблокирован'}
            </div>
            {check.blockers.length > 0 && (
              <ul className="col" style={{ paddingLeft: 18, marginTop: 8 }}>
                {check.blockers.map((b) => (
                  <li key={b.code} className="muted">
                    {b.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <div className="form-actions" style={{ marginTop: 12 }}>
          {can('release:execute') && (
            <Button variant="soft" busy={busy} disabled={!canRelease} onClick={() => run(() => http.post(`/applications/${data.number}/release-production`))}>
              Выпустить в производство
            </Button>
          )}
          {can('commercial:write') && commercial && commercial.contractStatus !== 'SIGNED' && (
            <Button variant="ghost" busy={busy} onClick={() => run(() => http.post(`/applications/${data.number}/commercial/sign-contract`, { lockVersion: commercial.lockVersion, contractNumber }))}>
              Подписать договор
            </Button>
          )}
          {can('release:approve:manual') && (
            <ManualApproval number={data.number} approval={commercial?.releaseApproval ?? null} busy={busy} onRun={run} />
          )}
        </div>
        <div className="subtle" style={{ marginTop: 8 }}>
          Ручное разрешение не создаёт оплату: предоплата приходит отдельным фактом из 1С.
        </div>
      </div>
    </div>
  );
}

function ManualApproval({
  number,
  approval,
  busy,
  onRun,
}: {
  number: string;
  approval: ReleaseApproval | null;
  busy: boolean;
  onRun: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  if (approval && !approval.revokedAt) {
    return (
      <div className="row">
        <span className="badge badge--warning">ручное разрешение выдано {formatDate(approval.approvedAt)}</span>
        <Button variant="ghost" busy={busy} onClick={() => onRun(() => http.del(`/applications/${number}/release-approval`, { reason: 'Основание устранено' }))}>
          Отозвать
        </Button>
      </div>
    );
  }

  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Ручное разрешение выпуска
      </Button>
      {open && (
        <Modal
          title="Ручное разрешение выпуска"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Отмена
              </Button>
              <Button
                busy={busy}
                onClick={async () => {
                  await onRun(() => http.post(`/applications/${number}/release-approval`, { reason }));
                  setOpen(false);
                }}
              >
                Разрешить с указанием причины
              </Button>
            </>
          }
        >
          <Field label="Причина (не менее 10 символов)">
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Например: срок контракта подтверждён устно, оплата поступит по факту выпуска" />
          </Field>
          <div className="subtle">Действие попадает в аудит с указанием основания (GATE-01).</div>
        </Modal>
      )}
    </>
  );
}

// ── Производство ─────────────────────────────────────────────────────────

const PRODUCER_API_STAGES = ['TO_PRODUCTION', 'DESIGN_IN_PROGRESS', 'DESIGN_COMPLETE', 'MANUFACTURING', 'READY_TO_SHIP', 'FULFILLMENT', 'CLOSED'];

function ProductionTab({ data, onDone }: { data: ApplicationDetail; onDone: () => void }) {
  const { can } = useAuth();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState('');

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const index = PRODUCER_API_STAGES.indexOf(data.stage);
  const nextStages = PRODUCER_API_STAGES.filter((_, i) => index >= 0 && i === index + 1);

  return (
    <div className="stack">
      <ErrorMessage error={error} />
      <div className="card">
        <div className="card__head">
          <h2>Производственный маршрут</h2>
          <div className="card__spacer" />
          <StageBadge stage={data.stage} />
        </div>

        <div className="row row--wrap" style={{ marginBottom: 12 }}>
          {PRODUCER_API_STAGES.map((stage, i) => (
            <div key={stage} className="row" style={{ gap: 6 }}>
              <span className={`badge${i <= index ? ' badge--brand' : ''}`}>{stageLabel(stage)}</span>
              {i < PRODUCER_API_STAGES.length - 1 && <span className="subtle">→</span>}
            </div>
          ))}
        </div>

        {can('production:stages:update') && nextStages.length > 0 && (
          <div className="row row--wrap">
            <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ width: 'auto' }}>
              <option value="">Следующий этап</option>
              {nextStages.map((stage) => (
                <option key={stage} value={stage}>
                  {stageLabel(stage)}
                </option>
              ))}
            </select>
            <Button busy={busy} disabled={!target} onClick={() => run(() => http.post(`/applications/${data.number}/production-stage`, { to: target }))}>
              Перевести
            </Button>
          </div>
        )}
        <div className="subtle" style={{ marginTop: 8 }}>
          Этапы производства меняет уполномоченный сотрудник производственного модуля; переход через этап невозможен (GATE-04).
        </div>
      </div>

      {data.releases && data.releases.length > 0 && (
        <div className="card">
          <div className="card__head">
            <h3>Выпуски</h3>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Статус</th>
                  <th>Выпущено</th>
                  <th>Завершено</th>
                  <th>Этап</th>
                </tr>
              </thead>
              <tbody>
                {data.releases.map((release) => (
                  <tr key={release.id}>
                    <td>
                      <StatusBadge status={release.status} />
                    </td>
                    <td>{formatDateTime(release.releasedAt)}</td>
                    <td>{formatDateTime(release.completedAt)}</td>
                    <td>{release.stage ? stageLabel(release.stage) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.slaInstances && data.slaInstances.length > 0 && (
        <div className="card">
          <div className="card__head">
            <h3>Нормативы сроков</h3>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Норматив</th>
                  <th>Этап</th>
                  <th>Срок</th>
                  <th>Статус</th>
                  <th>Причина паузы</th>
                </tr>
              </thead>
              <tbody>
                {data.slaInstances.map((sla) => (
                  <tr key={sla.id}>
                    <td>{sla.ruleName ?? sla.ruleCode}</td>
                    <td>{sla.stage ? stageLabel(sla.stage) : '—'}</td>
                    <td className="nowrap">{formatDateTime(sla.dueAt)}</td>
                    <td>
                      <StatusBadge status={sla.status} />
                    </td>
                    <td className="subtle">{sla.pauseReason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Исполнение и закрытие ─────────────────────────────────────────────────

function FulfilmentTab({ data, onDone }: { data: ApplicationDetail; onDone: () => void }) {
  const { can } = useAuth();
  const fulfilment = useAsync((signal) => http.get<Fulfilment>(`/applications/${data.number}/fulfilment`, signal), [data.number]);
  const closeCheck = useAsync((signal) => http.get<CloseCheck>(`/applications/${data.number}/close-check`, signal), [data.number]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [docOpen, setDocOpen] = useState(false);
  const [docType, setDocType] = useState('UPD');
  const [docNumber, setDocNumber] = useState('');
  const [closeComment, setCloseComment] = useState('');

  const reload = () => {
    fulfilment.reload();
    closeCheck.reload();
    onDone();
  };

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const fulfilmentDocs = fulfilment.data?.closingDocuments ?? [];
  const requiredDocs = fulfilmentDocs.filter((d) => d.isRequired && d.status !== 'CANCELLED');
  const registeredCount = requiredDocs.filter((d) => d.status === 'REGISTERED' || d.status === 'SIGNED').length;
  const fulfilmentCurrency = fulfilment.data?.application.currency ?? null;
  const outstandingAmount = fulfilment.data
    ? Math.max(0, fulfilment.data.finance.invoicedTotal - fulfilment.data.finance.paidTotal)
    : null;

  return (
    <div className="stack">
      <ErrorMessage error={error} />
      {fulfilment.error ? <ErrorMessage error={fulfilment.error} /> : null}

      <div className="card">
        <div className="card__head">
          <h2>Исполнение заказа</h2>
          <div className="card__spacer" />
          {fulfilment.data && <span className={`badge ${fulfilment.data.isFullyShipped ? 'badge--success' : 'badge--warning'}`}>{fulfilment.data.isFullyShipped ? 'отгружено полностью' : 'есть остаток'}</span>}
        </div>
        {fulfilment.loading ? (
          <Loading />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Позиция</th>
                    <th className="num">Заказано</th>
                    <th className="num">Отгружено</th>
                    <th className="num">Остаток</th>
                  </tr>
                </thead>
                <tbody>
                  {(fulfilment.data?.lines ?? []).map((line) => (
                    <tr key={line.lineId}>
                      <td>{line.name}</td>
                      <td className="num">
                        {line.orderQty} {line.unit}
                      </td>
                      <td className="num">{line.shippedQty}</td>
                      <td className="num" style={{ color: line.remainingQty > 0 ? 'var(--warning)' : 'var(--success)', fontWeight: 700 }}>
                        {line.remainingQty}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="kv" style={{ marginTop: 12 }}>
              <div className="kv__k">Выставлено</div>
              <div className="kv__v mono">{formatMoney(fulfilment.data?.finance.invoicedTotal, fulfilmentCurrency)}</div>
              <div className="kv__k">Оплачено</div>
              <div className="kv__v mono">{formatMoney(fulfilment.data?.finance.paidTotal, fulfilmentCurrency)}</div>
              <div className="kv__k">Остаток к оплате</div>
              <div className="kv__v mono">{formatMoney(outstandingAmount, fulfilmentCurrency)}</div>
              <div className="kv__k">Актуальность оплаты</div>
              <div className="kv__v mono">
                {fulfilment.data?.finance.paymentFreshnessMinutes === null || fulfilment.data?.finance.paymentFreshnessMinutes === undefined
                  ? 'нет зачётов'
                  : `${fulfilment.data.finance.paymentFreshnessMinutes} мин назад`}
              </div>
            </div>
          </>
        )}
      </div>

      {data.shipments.length > 0 && (
        <div className="card">
          <div className="card__head">
            <h3>Отгрузки из 1С</h3>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Документ</th>
                  <th>Дата</th>
                  <th>Статус</th>
                  <th>Перевозчик</th>
                  <th>Строк</th>
                </tr>
              </thead>
              <tbody>
                {data.shipments.map((shipment) => (
                  <tr key={shipment.id}>
                    <td>{shipment.number ?? shipment.extId}</td>
                    <td>{formatDate(shipment.docDate)}</td>
                    <td>
                      <StatusBadge status={shipment.status} />
                    </td>
                    <td>{shipment.carrier ?? '—'}</td>
                    <td>{shipment.lines?.length ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card__head">
          <h2>Закрывающие документы</h2>
          <div className="card__spacer" />
          {can('fulfillment:write') && (
            <Button variant="ghost" className="btn--sm" onClick={() => setDocOpen(true)}>
              Зарегистрировать документ
            </Button>
          )}
        </div>
        {data.closingDocs.length === 0 ? (
          <Empty>Комплект закрывающих документов не задан</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Тип</th>
                  <th>Номер</th>
                  <th>Статус</th>
                  <th>Источник</th>
                  <th>Зарегистрирован</th>
                </tr>
              </thead>
              <tbody>
                {data.closingDocs.map((doc) => (
                  <tr key={doc.id}>
                    <td>
                      {DOC_TYPE_LABELS[doc.docType] ?? doc.docType}
                      {doc.isRequired && (
                        <span className="badge badge--brand" style={{ marginLeft: 6 }}>
                          обязателен
                        </span>
                      )}
                    </td>
                    <td>{doc.number ?? '—'}</td>
                    <td>
                      <StatusBadge status={doc.status} />
                    </td>
                    <td className="subtle">{doc.source ?? '—'}</td>
                    <td>{formatDate(doc.registeredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {requiredDocs.length > 0 && (
          <div className="row row--wrap" style={{ marginTop: 10 }}>
            <span className="subtle">Комплект: {registeredCount} из {requiredDocs.length}</span>
            {requiredDocs.map((doc) => (
              <span key={doc.id} className={`badge ${doc.status === 'REGISTERED' || doc.status === 'SIGNED' ? 'badge--success' : 'badge--warning'}`}>
                {DOC_TYPE_LABELS[doc.docType] ?? doc.docType}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Готовность к закрытию</h2>
          <div className="card__spacer" />
          {closeCheck.data && (
            <span className={`badge ${closeCheck.data.canClose ? 'badge--success' : 'badge--danger'}`}>
              {closeCheck.data.canClose ? 'условия выполнены' : 'есть блокеры'}
            </span>
          )}
        </div>
        {closeCheck.loading ? (
          <Loading />
        ) : (
          <>
            {(closeCheck.data?.blockers.length ?? 0) > 0 && (
              <ul style={{ paddingLeft: 18, margin: 0 }}>
                {closeCheck.data!.blockers.map((b) => (
                  <li key={b.code} className="muted">
                    {b.message}
                  </li>
                ))}
              </ul>
            )}
            {can('close:execute') && (
              <div className="row row--wrap" style={{ marginTop: 12 }}>
                <input
                  placeholder="Комментарий к закрытию"
                  value={closeComment}
                  onChange={(e) => setCloseComment(e.target.value)}
                  style={{ maxWidth: 320 }}
                />
                <Button busy={busy} disabled={!closeCheck.data?.canClose} onClick={() => run(() => http.post(`/applications/${data.number}/close`, { lockVersion: data.lockVersion, comment: closeComment }))}>
                  Закрыть заявку
                </Button>
              </div>
            )}
            <div className="subtle" style={{ marginTop: 8 }}>
              Закрытие — отдельное действие (CLOSE-03). При корректировке оплаты или отгрузки заявка возвращается в исполнение с сохранением факта закрытия.
            </div>
          </>
        )}
      </div>

      {docOpen && (
        <Modal
          title="Регистрация закрывающего документа"
          onClose={() => setDocOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDocOpen(false)}>
                Отмена
              </Button>
              <Button
                busy={busy}
                onClick={async () => {
                  await run(() => http.post(`/applications/${data.number}/closing-documents`, { docType, docNumber: docNumber || null, source: 'CRM', status: 'REGISTERED' }));
                  setDocOpen(false);
                }}
              >
                Зарегистрировать
              </Button>
            </>
          }
        >
          <Field label="Тип документа">
            <select value={docType} onChange={(e) => setDocType(e.target.value)}>
              {Object.entries(DOC_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Номер документа">
            <input value={docNumber} onChange={(e) => setDocNumber(e.target.value)} />
          </Field>
          <div className="subtle">Документы из 1С приходят обменом; здесь регистрируется документ со стороны CRM с указанием источника (CLOSE-02).</div>
        </Modal>
      )}
    </div>
  );
}

// ── Задачи ───────────────────────────────────────────────────────────────

function TasksTab({ number, data, onDone }: { number: string; data: ApplicationDetail; onDone: () => void }) {
  const { can, user } = useAuth();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [assignees, setAssignees] = useState<{ id: string; fullName: string }[]>([]);
  const [type, setType] = useState('CALL');
  const [subject, setSubject] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const [completeTarget, setCompleteTarget] = useState<string | null>(null);
  const [result, setResult] = useState('');

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const tasks = data.tasks ?? [];

  return (
    <div className="stack">
      <ErrorMessage error={error} />
      <div className="row row--wrap">
        {can('task:create') && (
          <Button
            onClick={async () => {
              onErrorReset(setError);
              try {
                const list = await http.get<{ id: string; fullName: string }[]>('/users/assignable');
                setAssignees(list);
                setAssigneeId(user?.id ?? '');
                setOpen(true);
              } catch (err) {
                setError(err);
              }
            }}
          >
            Новая задача
          </Button>
        )}
        <span className="subtle">Срок задачи участвует в SLA; следующее действие пересчитывается автоматически.</span>
      </div>

      {tasks.length === 0 ? (
        <Empty>Задач по заявке нет</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Тема</th>
                <th>Тип</th>
                <th>Исполнитель</th>
                <th>Срок</th>
                <th>Приоритет</th>
                <th>Статус</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td>{task.subject}</td>
                  <td className="subtle">{task.type}</td>
                  <td>{task.assignee?.fullName ?? '—'}</td>
                  <td className="nowrap">{formatDateTime(task.dueAt)}</td>
                  <td>
                    <span className="badge">{task.priority}</span>
                  </td>
                  <td>
                    <StatusBadge status={task.status} />
                  </td>
                  <td>
                    <div className="row row--wrap">
                      {task.status === 'OPEN' && task.assigneeId === user?.id && (
                        <Button
                          variant="soft"
                          className="btn--sm"
                          onClick={() => {
                            setCompleteTarget(task.id);
                            setResult('');
                          }}
                        >
                          Завершить
                        </Button>
                      )}
                      {task.status === 'OPEN' && can('task:complete:other') && task.assigneeId !== user?.id && (
                        <Button variant="ghost" className="btn--sm" busy={busy} onClick={() => run(() => http.post(`/tasks/${task.id}/complete`, {}))}>
                          Завершить за другого
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

      {open && (
        <Modal
          title="Новая задача"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Отмена
              </Button>
              <Button
                busy={busy}
                onClick={async () => {
                  await run(() =>
                    http.post(`/applications/${number}/tasks`, {
                      type,
                      subject,
                      assigneeId,
                      dueAt: new Date(dueAt).toISOString(),
                      priority,
                    }),
                  );
                  setOpen(false);
                }}
              >
                Создать задачу
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="Тип задачи">
              <select value={type} onChange={(e) => setType(e.target.value)}>
                {['CALL', 'EMAIL', 'MEETING', 'TASK', 'FOLLOW_UP', 'OTHER'].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Приоритет">
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                {['LOW', 'NORMAL', 'HIGH', 'CRITICAL'].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Срок">
              <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </Field>
            <Field label="Исполнитель">
              <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                {assignees.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Тема">
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
        </Modal>
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
              <Button
                busy={busy}
                onClick={async () => {
                  await run(() => http.post(`/tasks/${completeTarget}/complete`, { result }));
                  setCompleteTarget(null);
                }}
              >
                Завершить
              </Button>
            </>
          }
        >
          <Field label="Результат">
            <textarea value={result} onChange={(e) => setResult(e.target.value)} />
          </Field>
        </Modal>
      )}
    </div>
  );
}

// ── Коммуникации ─────────────────────────────────────────────────────────

function ActivitiesTab({ number, data, onDone }: { number: string; data: ApplicationDetail; onDone: () => void }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState('CALL');
  const [direction, setDirection] = useState<'IN' | 'OUT'>('OUT');
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [result, setResult] = useState('');

  const activities = data.activities ?? [];

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <ErrorMessage error={error} />
      <div className="row row--wrap">
        <Button onClick={() => setOpen(true)}>Зарегистрировать коммуникацию</Button>
        <span className="subtle">Коррекция сохраняет предыдущее значение и автора правки (§10.1).</span>
      </div>

      {activities.length === 0 ? (
        <Empty>Коммуникаций не зарегистрировано</Empty>
      ) : (
        <div className="stack">
          {activities.map((activity) => (
            <div key={activity.id} className="card" style={{ boxShadow: 'none' }}>
              <div className="row row--wrap">
                <span className="badge badge--brand">{ACTIVITY_LABELS[activity.type] ?? activity.type}</span>
                {activity.direction && <span className="badge">{activity.direction === 'IN' ? 'входящая' : 'исходящая'}</span>}
                {activity.isCustomerFacing && <span className="badge badge--success">контакт с клиентом</span>}
                <strong>{activity.subject ?? '—'}</strong>
                <div className="card__spacer" />
                <span className="subtle nowrap">{formatDateTime(activity.occurredAt)}</span>
              </div>
              <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{activity.content ?? ''}</div>
              {activity.result && (
                <div className="subtle" style={{ marginTop: 6 }}>
                  Результат: {activity.result}
                </div>
              )}
              <div className="row" style={{ marginTop: 8 }}>
                <span className="subtle">
                  Автор: {activity.author?.fullName ?? '—'}
                  {activity.correctedById && ' · запись скорректирована'}
                </span>
                {activity.previousContent && (
                  <span className="subtle" title={activity.previousContent}>
                    · исправлено
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <Modal
          title="Регистрация коммуникации"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Отмена
              </Button>
              <Button
                busy={busy}
                onClick={async () => {
                  await run(() =>
                    http.post(`/applications/${number}/activities`, {
                      type,
                      direction,
                      subject,
                      content,
                      result: result || null,
                      isCustomerFacing: ['CALL', 'EMAIL', 'MEETING'].includes(type),
                    }),
                  );
                  setOpen(false);
                  setSubject('');
                  setContent('');
                  setResult('');
                }}
              >
                Сохранить
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="Тип">
              <select value={type} onChange={(e) => setType(e.target.value)}>
                {Object.entries(ACTIVITY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Направление">
              <select value={direction} onChange={(e) => setDirection(e.target.value as 'IN' | 'OUT')}>
                <option value="OUT">Исходящая</option>
                <option value="IN">Входящая</option>
              </select>
            </Field>
          </div>
          <Field label="Тема">
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Содержание">
            <textarea value={content} onChange={(e) => setContent(e.target.value)} />
          </Field>
          <Field label="Результат">
            <input value={result} onChange={(e) => setResult(e.target.value)} />
          </Field>
          <div className="subtle">Технический опрос интеграции не освежает дату коммерческой активности.</div>
        </Modal>
      )}
    </div>
  );
}

// ── Инженерные задания ───────────────────────────────────────────────────

function EngineeringTab({ data, onDone }: { data: ApplicationDetail; onDone: () => void }) {
  const { can } = useAuth();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [assignees, setAssignees] = useState<{ id: string; fullName: string }[]>([]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <ErrorMessage error={error} />
      <div className="row row--wrap">
        {can('eng:task:create') && (
          <Button
            busy={busy}
            onClick={() => run(() => http.post(`/applications/${data.number}/engineering-tasks`, { kind: 'PREQUOTE', priority: 'NORMAL' }))}
          >
            Создать предварительное задание
          </Button>
        )}
        <span className="subtle">Конструкторов назначает руководитель КО; продавец создаёт задание без назначения (§3.1).</span>
      </div>

      {(data.engTasks ?? []).length === 0 ? (
        <Empty>Инженерных заданий нет</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
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
            {data.engTasks.map((task) => (
              <tr key={task.id}>
                <td>{task.kind === 'PREQUOTE' ? 'Предварительное' : 'Документация'}</td>
                <td>
                  <StatusBadge status={task.status} />
                </td>
                <td>
                  <span className="badge">{task.priority}</span>
                </td>
                <td>{task.assignee?.fullName ?? '—'}</td>
                <td>{formatDate(task.dueAt)}</td>
                <td>{task.decision ?? '—'}</td>
                <td>
                  <div className="row row--wrap">
                    {can('eng:assign') && !task.assigneeId && assignees.length === 0 && (
                      <Button
                        variant="ghost"
                        className="btn--sm"
                        onClick={async () => {
                          try {
                            const list = await http.get<{ id: string; fullName: string; role?: string }[]>('/users/assignable');
                            setAssignees(list.filter((u) => u.role === 'DESIGNER' || u.role === 'DESIGN_MANAGER'));
                            setError(null);
                          } catch (err) {
                            setError(err);
                          }
                        }}
                      >
                        Выбрать конструктора
                      </Button>
                    )}
                    {can('eng:assign') && !task.assigneeId && assignees.length > 0 && (
                      <select
                        defaultValue=""
                        onChange={(e) => {
                          if (e.target.value) run(() => http.post(`/engineering/tasks/${task.id}/assign`, { assigneeId: e.target.value }));
                        }}
                        style={{ width: 'auto' }}
                      >
                        <option value="" disabled>
                          Выбрать конструктора
                        </option>
                        {assignees.map((user) => (
                          <option key={user.id} value={user.id}>
                            {user.fullName}
                          </option>
                        ))}
                      </select>
                    )}
                    {task.conclusionId && can('eng:conclusion:approve') && (
                      <Button variant="soft" className="btn--sm" busy={busy} onClick={() => run(() => http.post(`/engineering/conclusions/${task.conclusionId}/approve`, { approve: true }))}>
                        Утвердить заключение
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
    </div>
  );
}

// ── История ──────────────────────────────────────────────────────────────

function HistoryTab({ number }: { number: string }) {
  const timeline = useAsync((signal) => http.get<import('../api/types').Timeline>(`/applications/${number}/timeline`, signal), [number]);

  if (timeline.loading) return <Loading label="Загружаю историю…" />;
  if (timeline.error) return <ErrorMessage error={timeline.error} />;

  const events = [
    ...(timeline.data?.stageEvents ?? []).map((e) => ({ at: e.createdAt, title: `Этап: ${stageLabel(e.toStage)}`, detail: e.comment, icon: '→' })),
    ...(timeline.data?.activities ?? []).map((a) => ({ at: a.occurredAt, title: `${ACTIVITY_LABELS[a.type] ?? a.type}: ${a.subject ?? ''}`, detail: a.content, icon: '✉' })),
    ...(timeline.data?.tasks ?? []).map((t) => ({ at: t.dueAt, title: `Задача: ${t.subject}`, detail: t.result ?? '', icon: '✓' })),
    ...(timeline.data?.shipments ?? []).map((s) => ({ at: s.docDate ?? '', title: `Отгрузка ${s.number ?? s.extId}`, detail: s.status, icon: '⇪' })),
  ]
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  if (events.length === 0) return <Empty>Событий пока нет</Empty>;

  return (
    <div className="card">
      {events.map((event, index) => (
        <div key={`${event.title}-${index}`} className="timeline-item">
          <div className="row row--wrap">
            <strong>{event.title}</strong>
            <div className="card__spacer" />
            <span className="subtle nowrap">{formatDateTime(event.at)}</span>
          </div>
          {event.detail && <div className="subtle">{event.detail}</div>}
        </div>
      ))}
    </div>
  );
}

// ── Вспомогательное ──────────────────────────────────────────────────────

function complexityLabelOf(value?: string | null): string {
  if (!value) return 'Не классифицирована';
  return value;
}

function complexityLabel(code: string): string {
  const map: Record<string, string> = {
    NEEDS_CLASSIFICATION: 'Требует классификации',
    STANDARD: 'Стандартная',
    MODIFIED: 'Модифицированная',
    CUSTOM: 'Нестандартная',
  };
  return map[code] ?? code;
}

/** Переходы задаются маршрутом этапов; UI предлагает только следующий шаг. */
function nextStages(current: string, all: string[]): string[] {
  const order = all;
  const index = order.indexOf(current);
  if (index < 0) return [];
  return [order[index + 1]].filter(Boolean);
}

function onErrorReset(setter: (value: unknown) => void): void {
  setter(null);
}

function serverErrorField(error: unknown): string | undefined {
  return serverField(error, 'to');
}

export type { Quote, Commercial, ReleaseCheck };