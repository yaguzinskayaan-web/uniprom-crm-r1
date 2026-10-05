import { config } from '../config.js';

/**
 * A19/A45: транспорт доставки исходящих очередей.
 *
 * Транспорт намеренно узкий: он либо возвращает подтверждение, либо явную ошибку.
 * Неопределённый результат (сеть недоступна, нет ответа) не считается успехом —
 * вызывающий код переводит задание в UNKNOWN, чтобы не было ложного SENT и слепой
 * повторной отправки (SEND-03).
 */

export type DeliveryResult =
  | { ok: true; providerMessageId?: string }
  | { ok: false; definitive: boolean; error: string };

/** Ошибка доставки с признаком, известен ли результат точно. */
export class DeliveryError extends Error {
  readonly definitive: boolean;

  constructor(message: string, definitive: boolean) {
    super(message);
    this.name = 'DeliveryError';
    this.definitive = definitive;
  }
}

async function post(url: string, payload: unknown, headers: Record<string, string> = {}): Promise<DeliveryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.deliveryTimeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.ok) {
      const text = await res.text();
      let providerMessageId: string | undefined;
      try {
        const parsed = JSON.parse(text) as { messageId?: string; id?: string };
        providerMessageId = parsed.messageId ?? parsed.id;
      } catch {
        providerMessageId = undefined;
      }
      return { ok: true, providerMessageId };
    }
    // Ответ получен — результат известен точно: адрес отверг запрос.
    return {
      ok: false,
      definitive: true,
      error: `HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    // Сеть недоступна или таймаут — неизвестно, доставлено ли сообщение.
    return {
      ok: false,
      definitive: false,
      error: aborted
        ? `Таймаут доставки ${config.deliveryTimeoutMs} мс`
        : `Сбой доставки: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Отправка письма с КП. Без настроенного `MAIL_TRANSPORT_URL` доставка не
 * выполняется, а задание переводится в UNKNOWN — CRM не притворяется, что
 * письмо ушло.
 */
export async function sendMail(payload: {
  to: string[];
  subject?: string | null;
  body?: string | null;
  dispatchId: string;
}): Promise<DeliveryResult> {
  if (!config.mailTransportUrl) {
    return {
      ok: false,
      definitive: false,
      error: 'Почтовый транспорт не настроен (MAIL_TRANSPORT_URL). Задание ожидает настройки.',
    };
  }
  return post(config.mailTransportUrl, payload, { 'x-integration-token': config.integrationToken });
}

/**
 * Доставка события в 1С. Без `OUTBOX_TARGET_URL` очередь остаётся в ожидании,
 * её возраст виден в разделе интеграций.
 */
export async function deliverOutbox(payload: {
  id: string;
  eventType: string;
  objectType: string;
  extId: string;
  applicationId: string | null;
  versionNo: number;
  body: unknown;
  attempts: number;
}): Promise<DeliveryResult> {
  if (!config.outboxTargetUrl) {
    return {
      ok: false,
      definitive: false,
      error: 'Адрес получателя 1С не настроен (OUTBOX_TARGET_URL). Событие осталось в очереди.',
    };
  }
  return post(config.outboxTargetUrl, payload, { 'x-integration-token': config.integrationToken });
}