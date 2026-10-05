import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { http } from '../api/client';
import type { MailMessage, PagedResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Button, Empty, ErrorMessage, Field, Loading, Modal, StatusBadge, formatDateTime, serverField, useAsync } from '../components/ui';

/** §5.2 разбор входящей почты: создать заявку, привязать к существующей или проигнорировать. */
export function MailPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [mail, setMail] = useState<MailMessage | null>(null);
  const [orgName, setOrgName] = useState('');
  const [inn, setInn] = useState('');
  const [contactName, setContactName] = useState('');
  const [linkNumber, setLinkNumber] = useState('');
  const [ignoreReason, setIgnoreReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const inbox = useAsync(
    (signal) => {
      const query = new URLSearchParams({ size: '50' });
      if (status) query.set('status', status);
      return http.get<PagedResponse<MailMessage>>(`/mail/inbox?${query.toString()}`, signal);
    },
    [status],
  );

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      inbox.reload();
      setNotice(null);
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
          <h1>Входящая почта</h1>
          <div className="subtle">Необработанные письма ждут разбора; связь с заявкой сохраняется в хронологии</div>
        </div>
        <div className="card__spacer" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
          <option value="">Все письма</option>
          <option value="NEW">Новые</option>
          <option value="LINKED">Связаны</option>
          <option value="IGNORED">Проигнорированы</option>
        </select>
      </div>

      {error && <ErrorMessage error={error} />}
      {notice && <div className="alert alert--success">{notice}</div>}

      {inbox.loading ? (
        <Loading />
      ) : (inbox.data?.items.length ?? 0) === 0 ? (
        <Empty>Писем нет</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Получено</th>
                <th>Отправитель</th>
                <th>Тема</th>
                <th>Статус</th>
                <th>Заявка</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {inbox.data!.items.map((item) => (
                <tr key={item.id}>
                  <td className="nowrap">{formatDateTime(item.receivedAt)}</td>
                  <td>
                    {item.from}
                    <div className="subtle">{item.to}</div>
                  </td>
                  <td>{item.subject}</td>
                  <td>
                    <StatusBadge status={item.status} />
                  </td>
                  <td className="mono">{item.applicationNumber ?? '—'}</td>
                  <td>
                    {can('mail:inbox:process') && item.status === 'NEW' && (
                      <Button variant="ghost" className="btn--sm" onClick={() => setMail(item)}>
                        Разобрать
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {mail && (
        <Modal title="Разбор письма" onClose={() => setMail(null)}>
          <ErrorMessage error={error} />
          <div className="card" style={{ boxShadow: 'none', background: 'var(--surface-alt)' }}>
            <div className="row row--wrap">
              <strong>{mail.subject}</strong>
              <div className="card__spacer" />
              <span className="subtle">{formatDateTime(mail.receivedAt)}</span>
            </div>
            <div className="subtle">
              {mail.from} → {mail.to}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{mail.bodyText ?? ''}</div>
          </div>

          <div className="divider" />
          <h3>Создать заявку из письма</h3>
          <div className="form-grid">
            <Field label="Организация" error={serverField(error, 'organizationName')}>
              <input value={orgName} onChange={(e) => setOrgName(e.target.value)} />
            </Field>
            <Field label="ИНН">
              <input value={inn} onChange={(e) => setInn(e.target.value)} />
            </Field>
            <Field label="Контакт">
              <input value={contactName} onChange={(e) => setContactName(e.target.value)} />
            </Field>
          </div>
          <div className="form-actions">
            <Button
              busy={busy}
              disabled={!orgName}
              onClick={async () => {
                await run(() =>
                  // Ответ — конверт { application, deduplicated }, номер заявки
                  // здесь не нужен: мы возвращаемся к списку.
                  http.post(`/mail/${mail.id}/create-application`, {
                    organizationName: orgName,
                    inn: inn || undefined,
                    contactName: contactName || undefined,
                  }),
                );
                navigate('/applications');
              }}
            >
              Создать заявку
            </Button>
          </div>

          <div className="divider" />
          <h3>Связать с существующей заявкой</h3>
          <div className="row row--wrap">
            <input placeholder="Номер заявки, например UPC-2026-00001" value={linkNumber} onChange={(e) => setLinkNumber(e.target.value)} style={{ maxWidth: 280 }} />
            <Button
              busy={busy}
              disabled={!linkNumber}
              onClick={async () => {
                await run(() => http.post(`/mail/${mail.id}/link`, { applicationNumber: linkNumber }));
                setNotice(`Письмо связано с заявкой ${linkNumber}`);
                setMail(null);
              }}
            >
              Связать
            </Button>
          </div>

          <div className="divider" />
          <h3>Проигнорировать</h3>
          <div className="row row--wrap">
            <input placeholder="Причина" value={ignoreReason} onChange={(e) => setIgnoreReason(e.target.value)} style={{ maxWidth: 280 }} />
            <Button
              variant="ghost"
              busy={busy}
              disabled={!ignoreReason}
              onClick={async () => {
                await run(() => http.post(`/mail/${mail.id}/ignore`, { reason: ignoreReason }));
                setMail(null);
              }}
            >
              Проигнорировать
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}