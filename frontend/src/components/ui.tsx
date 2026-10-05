import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, http } from '../api/client';

// ── Индикатор загрузки и пустое состояние ──────────────────────────────────

export function Loading({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <div className="row" style={{ padding: '10px 0' }}>
      <span className="spinner spinner--dark" />
      <span className="muted">{label}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

// ── Сообщения об ошибках: Zod 422 показывается построчно (UX-01) ────────────

export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  if (error instanceof ApiError) {
    return (
      <div className="alert alert--error" role="alert">
        <span>{error.message}</span>
        {error.fields.length > 0 && (
          <ul>
            {error.fields.map((f, i) => (
              <li key={`${f.field}-${i}`}>{f.field ? `${f.field}: ${f.message}` : f.message}</li>
            ))}
          </ul>
        )}
        {error.status === 409 && <span className="subtle">Обновите данные и повторите действие.</span>}
        {error.status === 403 && <span className="subtle">Недостаточно прав. Обратитесь к руководителю.</span>}
        {error.status === 422 && <span className="subtle">Проверьте заполнение полей.</span>}
      </div>
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="alert alert--error" role="alert">
      {message}
    </div>
  );
}

export function SuccessMessage({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="alert alert--success" role="status">
      {text}
    </div>
  );
}

// ── Загрузка данных с отменой устаревших запросов (UX-02) ──────────────────

export function useAsync<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    loader(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadKey]);

  return { data, error, loading, reload: () => setReloadKey((k) => k + 1), setData };
}

// ── Кнопка с состоянием выполнения ────────────────────────────────────────

export function Button({
  children,
  busy,
  variant = 'primary',
  className = '',
  ...rest
}: {
  children: ReactNode;
  busy?: boolean;
  variant?: 'primary' | 'ghost' | 'soft' | 'danger';
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const variantClass =
    variant === 'ghost' ? 'btn btn--ghost' : variant === 'soft' ? 'btn btn--soft' : variant === 'danger' ? 'btn btn--danger' : 'btn';
  return (
    <button type="button" className={`${variantClass} ${className}`.trim()} disabled={busy || rest.disabled} {...rest}>
      {busy && <span className="spinner" />}
      {children}
    </button>
  );
}

// ── Модальное окно ────────────────────────────────────────────────────────

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__head">
          <h2>{title}</h2>
          <div className="card__spacer" />
          <Button variant="ghost" onClick={onClose} aria-label="Закрыть">
            ✕
          </Button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

// ── Поля формы с поддержкой ошибок сервера ────────────────────────────────

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {error && <span className="field__error">{error}</span>}
    </label>
  );
}

export function serverField(error: unknown, field: string): string | undefined {
  if (error instanceof ApiError) return error.fields.find((f) => f.field === field)?.message;
  return undefined;
}

// ── Форматирование ────────────────────────────────────────────────────────

export function formatMoney(amount: number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined) return '—';
  const value = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount);
  return currency ? `${value} ${currency}` : value;
}

export function formatDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** Склонение существительных: 1 заявка, 2 заявки, 5 заявок. */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

// ── Метки этапов и статусов (единый словарь интерфейса) ───────────────────

export const STAGE_LABELS: Record<string, string> = {
  NEW: 'Новая',
  SALES_REVIEW: 'Проверка продаж',
  QUOTE_PREPARED: 'КП подготовлено',
  KO_QUEUE: 'Очередь КО',
  KO_ASSIGNED: 'Задано конструктору',
  PREQUOTE_DONE: 'Предварительное заключение',
  KO_APPROVED: 'Заключение утверждено',
  QUOTE_PRESENTED: 'КП направлено',
  QUOTE_NEGOTIATION: 'Переговоры',
  CUSTOMER_DECISION: 'Решение клиента',
  ORDER_CONFIRMED: 'Заказ подтверждён',
  CONTRACT_PENDING: 'Ожидает договора',
  CONTRACT_SIGNED: 'Договор подписан',
  TO_PRODUCTION: 'Выпущена в производство',
  DESIGN_IN_PROGRESS: 'Проектирование',
  DESIGN_COMPLETE: 'Проектирование завершено',
  MANUFACTURING: 'Производство',
  READY_TO_SHIP: 'Готово к отгрузке',
  FULFILLMENT: 'Исполнение',
  CLOSED: 'Закрыта',
  CANCELLED: 'Отказ',
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

export const TASK_TYPE_LABELS: Record<string, string> = {
  CALL: 'Звонок',
  EMAIL: 'Письмо',
  MEETING: 'Встреча',
  TASK: 'Задача',
  FOLLOW_UP: 'Контроль',
  OTHER: 'Прочее',
};

export const ACTIVITY_LABELS: Record<string, string> = {
  CALL: 'Звонок',
  EMAIL: 'Письмо',
  MEETING: 'Встреча',
  NOTE: 'Заметка',
  SYSTEM: 'Системное событие',
  OTHER: 'Прочее',
};

export const DOC_TYPE_LABELS: Record<string, string> = {
  UPD: 'УПД',
  NAKLADNAYA: 'Товарная накладная',
  SF: 'Счёт-фактура',
  ACT: 'Акт',
};

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'DONE' || status === 'SIGNED' || status === 'REGISTERED' || status === 'CLOSED' || status === 'ACCEPTED' || status === 'COMPLETED'
      ? 'badge badge--success'
      : status === 'CANCELLED' || status === 'REJECTED' || status === 'LOST' || status === 'NOT_FEASIBLE'
        ? 'badge badge--danger'
        : status === 'OPEN' || status === 'IN_PROGRESS' || status === 'ASSIGNED' || status === 'PENDING'
          ? 'badge badge--brand'
          : 'badge';
  return <span className={tone}>{status}</span>;
}

export function StageBadge({ stage }: { stage: string }) {
  const tone = stage === 'CLOSED' ? 'badge badge--success' : stage === 'CANCELLED' ? 'badge badge--danger' : 'badge badge--brand';
  return <span className={tone}>{stageLabel(stage)}</span>;
}

/** Сохранить файл из текстового ответа API (CSV-выгрузка). */
export async function downloadCsv(filename: string, path: string): Promise<void> {
  const text = await http.text(path);
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}