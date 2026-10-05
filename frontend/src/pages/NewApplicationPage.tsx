import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { http } from '../api/client';
import type { ApplicationListItem, Organization } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useReferences } from '../data/references';
import { Button, ErrorMessage, Field, serverField } from '../components/ui';

interface LineDraft {
  name: string;
  quantity: string;
  unit: string;
  price: string;
  catalogRef: string;
}

/**
 * Создание заявки. IN-03: ключ идемпотентности формируется один раз на форму,
 * повторная отправка не создаёт вторую заявку.
 */
export function NewApplicationPage() {
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const { refs } = useReferences();

  const [idempotencyKey] = useState(() => `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [organizationName, setOrganizationName] = useState('');
  const [inn, setInn] = useState('');
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Organization[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [source, setSource] = useState('MANUAL');
  const [sourceRef, setSourceRef] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const [expectedDecisionDate, setExpectedDecisionDate] = useState('');
  const [successProbability, setSuccessProbability] = useState('');
  const [tags, setTags] = useState('');
  const [crmComment, setCrmComment] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ name: '', quantity: '1', unit: 'PCS', price: '', catalogRef: '' }]);
  const [leaveInQueue, setLeaveInQueue] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);

  const updateLine = (index: number, patch: Partial<LineDraft>) => {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };

  const searchOrgs = async () => {
    setError(null);
    try {
      const result = await http.get<{ items: Organization[] }>(`/crm/organizations?search=${encodeURIComponent(search)}`);
      setFound(result.items ?? []);
    } catch (err) {
      setError(err);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setDuplicateWarning(null);
    setBusy(true);
    try {
      const payload = {
        idempotencyKey,
        ...(mode === 'existing' && selectedOrg ? { organizationId: selectedOrg.id } : { organizationName, inn: inn || undefined }),
        contactName: contactName || undefined,
        contactPhone: contactPhone || undefined,
        contactEmail: contactEmail || undefined,
        source,
        sourceRef: sourceRef || undefined,
        priority,
        expectedDecisionDate: expectedDecisionDate ? new Date(expectedDecisionDate).toISOString() : undefined,
        successProbability: successProbability ? Number(successProbability) : undefined,
        tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        crmComment: crmComment || undefined,
        leaveInQueue,
        lines: lines
          .filter((line) => line.name.trim())
          .map((line) => ({
            name: line.name.trim(),
            quantity: Number(line.quantity) || 1,
            unit: line.unit,
            price: line.price ? Number(line.price) : undefined,
            catalogRef: line.catalogRef || undefined,
          })),
      };

      // Ответ сервера — это конверт с созданной заявкой, а не сама заявка:
// номер лежит в application.number. Раньше читался result.number, который
// всегда был undefined, и форма уходила на /applications/undefined.
      const result = await http.post<{ application: ApplicationListItem; deduplicated?: boolean }>('/applications', payload);
      if (result.deduplicated) {
        setDuplicateWarning('Заявка с таким ключом уже создана — открывается существующая карточка.');
      }
      navigate(`/applications/${result.application.number}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="row">
        <Button variant="ghost" onClick={() => navigate(-1)}>
          ← Назад
        </Button>
        <div>
          <h1>Новая заявка</h1>
          <div className="subtle">Ключ идемпотентности: {idempotencyKey} — повторная отправка не создаст дубль (IN-03)</div>
        </div>
      </div>

      {error && <ErrorMessage error={error} />}
      {duplicateWarning && <div className="alert alert--warning">{duplicateWarning}</div>}

      <form className="stack" onSubmit={submit}>
        <div className="card">
          <div className="card__head">
            <h2>Контрагент</h2>
            <div className="card__spacer" />
            <div className="row">
              <Button variant={mode === 'new' ? 'soft' : 'ghost'} className="btn--sm" onClick={() => setMode('new')} type="button">
                Новый
              </Button>
              <Button variant={mode === 'existing' ? 'soft' : 'ghost'} className="btn--sm" onClick={() => setMode('existing')} type="button">
                Найти существующего
              </Button>
            </div>
          </div>

          {mode === 'new' ? (
            <div className="form-grid">
              <Field label="Организация" error={serverField(error, 'organizationName')}>
                <input value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} required />
              </Field>
              <Field label="ИНН">
                <input value={inn} onChange={(e) => setInn(e.target.value)} inputMode="numeric" />
              </Field>
            </div>
          ) : (
            <div className="stack">
              <div className="row row--wrap">
                <input placeholder="Название или ИНН" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 320 }} />
                <Button variant="ghost" type="button" onClick={searchOrgs}>
                  Найти
                </Button>
              </div>
              {found.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Организация</th>
                        <th>ИНН</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {found.map((org) => (
                        <tr key={org.id}>
                          <td>{org.name}</td>
                          <td>{org.inn}</td>
                          <td>
                            <Button
                              variant="ghost"
                              className="btn--sm"
                              type="button"
                              onClick={() => {
                                setSelectedOrg(org);
                                setOrganizationName(org.name);
                              }}
                            >
                              Выбрать
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {selectedOrg && <div className="alert alert--info">Выбрана организация {selectedOrg.name}</div>}
              <div className="subtle">Поиск возвращает минимальные реквизиты без чужой коммерческой истории (RBAC-02).</div>
            </div>
          )}

          <div className="divider" />
          <div className="form-grid">
            <Field label="Контакт">
              <input value={contactName} onChange={(e) => setContactName(e.target.value)} />
            </Field>
            <Field label="Телефон">
              <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
            </Field>
            <Field label="E-mail">
              <input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
            </Field>
          </div>
        </div>

        <div className="card">
          <div className="card__head">
            <h2>Параметры заявки</h2>
          </div>
          <div className="form-grid">
            <Field label="Источник" error={serverField(error, 'source')}>
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                {refs.sources.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Приоритет" error={serverField(error, 'priority')}>
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                {refs.priorities.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Ссылка на источник">
              <input value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} />
            </Field>
            <Field label="Ожидаемое решение">
              <input type="date" value={expectedDecisionDate} onChange={(e) => setExpectedDecisionDate(e.target.value)} />
            </Field>
            <Field label="Вероятность, %">
              <input type="number" min={0} max={100} value={successProbability} onChange={(e) => setSuccessProbability(e.target.value)} />
            </Field>
            <Field label="Метки через запятую">
              <input value={tags} onChange={(e) => setTags(e.target.value)} />
            </Field>
          </div>
          <div style={{ marginTop: 12 }}>
            <Field label="Комментарий">
              <textarea value={crmComment} onChange={(e) => setCrmComment(e.target.value)} />
            </Field>
          </div>
        </div>

        <div className="card">
          <div className="card__head">
            <h2>Позиции</h2>
            <div className="card__spacer" />
            <Button
              variant="ghost"
              className="btn--sm"
              type="button"
              onClick={() => setLines((prev) => [...prev, { name: '', quantity: '1', unit: 'PCS', price: '', catalogRef: '' }])}
            >
              Добавить позицию
            </Button>
          </div>
          {lines.map((line, index) => (
            <div key={index} className="row row--wrap" style={{ marginBottom: 8 }}>
              <input
                placeholder="Наименование"
                value={line.name}
                onChange={(e) => updateLine(index, { name: e.target.value })}
                style={{ flex: '3 1 220px' }}
                aria-invalid={serverField(error, `lines.${index}.name`) ? true : undefined}
              />
              <input
                type="number"
                min={0}
                step="0.001"
                value={line.quantity}
                onChange={(e) => updateLine(index, { quantity: e.target.value })}
                style={{ flex: '0 1 100px' }}
                aria-invalid={serverField(error, `lines.${index}.quantity`) ? true : undefined}
              />
              <select value={line.unit} onChange={(e) => updateLine(index, { unit: e.target.value })} style={{ flex: '0 1 120px' }}>
                {refs.units.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={0}
                step="0.01"
                placeholder="Цена"
                value={line.price}
                onChange={(e) => updateLine(index, { price: e.target.value })}
                style={{ flex: '0 1 120px' }}
              />
              <input placeholder="Артикул" value={line.catalogRef} onChange={(e) => updateLine(index, { catalogRef: e.target.value })} style={{ flex: '1 1 130px' }} />
              <Button
                variant="ghost"
                className="btn--sm"
                type="button"
                onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                disabled={lines.length === 1}
              >
                ✕
              </Button>
            </div>
          ))}
          {serverField(error, 'lines') && <div className="field__error">{serverField(error, 'lines')}</div>}
          <div className="subtle">Уровень сложности заявки определяется как максимум по позициям (ENG-01).</div>
        </div>

        <div className="card">
          <div className="row row--wrap">
            {can('application:assign') && (
              <label className="checkbox">
                <input type="checkbox" checked={leaveInQueue} onChange={(e) => setLeaveInQueue(e.target.checked)} />
                Оставить в очереди без ответственного
              </label>
            )}
            <div className="card__spacer" />
            <Button type="submit" busy={busy} disabled={lines.filter((l) => l.name.trim()).length === 0}>
              Создать заявку от {user?.fullName}
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}