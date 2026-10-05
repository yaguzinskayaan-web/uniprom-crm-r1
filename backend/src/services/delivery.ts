import { prisma } from '../lib/prisma.js';
import { config, newCorrelationId } from '../config.js';
import { audit, AuditAction } from '../lib/audit.js';
import { deliverOutbox, sendMail, type DeliveryResult } from '../lib/delivery.js';
import { confirmDispatch } from './quotes.js';
import { notify, NotifyCode } from '../lib/notifications.js';

/**
 * A19/A45: фоновая доставка исходящих очередей — писем с КП и событий для 1С.
 *
 * Правила повторов:
 *  - попытка считается неуспешной только при известном отказе; при неизвестном
 *    результате письмо переходит в UNKNOWN и не отправляется вслепую (SEND-03);
 *  - интервал до следующей попытки растёт экспоненциально и ограничен часом;
 *  - исчерпание попыток переводит задание в конечное состояние, оно остаётся
 *    видимым в интерфейсе вместе с причиной;
 *  - выдача задания защищена обновлением по идентификатору, поэтому два
 *    процесса не заберут одно и то же задание дважды.
 */

const BATCH_LIMIT = 20;

export function nextBackoffMs(attempts: number): number {
  return Math.min(config.deliveryBackoffBaseMs * 2 ** Math.max(0, attempts - 1), 60 * 60_000);
}

function maxAttempts(): number {
  return 8;
}

function textOf(value: unknown, fallback: string): string {
  const s = String(value ?? '').trim();
  return s || fallback;
}

export interface DeliverySummary {
  mail: { sent: number; retried: number; unknown: number; failed: number };
  outbox: { delivered: number; retried: number; failed: number };
  /** Очередь не обработана: транспорт не настроен, задания остались в исходном состоянии. */
  skipped: boolean;
}

/** Доставка писем с КП, ожидающих в очереди. */
async function runMailQueue(correlationId: string): Promise<DeliverySummary['mail']> {
  const summary = { sent: 0, retried: 0, unknown: 0, failed: 0 };
  // Пока SMTP/транспорт не настроен, очередь не трогаем: попытка доставки без
  // транспорта сожгла бы лимит повторов и перевела письма в FAILED по существу
  // не по вине системы. Задания остаются QUEUED до появления транспорта.
  if (!config.mailTransportUrl) return summary;
  const due = await prisma.crmQuoteDispatch.findMany({
    where: {
      isManual: false,
      queueState: 'QUEUED',
      nextAttemptAt: { lte: new Date() },
      attempts: { lt: maxAttempts() },
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH_LIMIT,
  });

  for (const dispatch of due) {
    // Захват: задание переводится в PROCESSING, чтобы его не забрал другой процесс.
    const claimed = await prisma.crmQuoteDispatch.updateMany({
      where: { id: dispatch.id, queueState: 'QUEUED' },
      data: { queueState: 'PROCESSING', lastAttemptAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue;

    let recipients: string[] = [];
    try {
      const parsed = JSON.parse(dispatch.recipients) as unknown;
      if (Array.isArray(parsed)) recipients = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      recipients = [];
    }

    const result: DeliveryResult = await sendMail({
      to: recipients,
      subject: dispatch.subject,
      body: dispatch.body,
      dispatchId: dispatch.id,
    });

    if (result.ok) {
      if (result.providerMessageId) {
        await prisma.crmQuoteDispatch.update({
          where: { id: dispatch.id },
          data: { providerMessageId: result.providerMessageId },
        });
      }
      await confirmDispatch(dispatch.id, correlationId, 'MAIL_WORKER');
      summary.sent += 1;
      continue;
    }

    const attempts = dispatch.attempts + 1;
    const exhausted = attempts >= maxAttempts();
    // Неизвестный результат никогда не превращается в слепой повтор.
    const state = result.definitive && !exhausted ? 'QUEUED' : exhausted ? 'FAILED' : 'UNKNOWN';
    await prisma.crmQuoteDispatch.update({
      where: { id: dispatch.id },
      data: {
        queueState: state,
        errorText: result.error.slice(0, 1000),
        nextAttemptAt: new Date(Date.now() + nextBackoffMs(attempts)),
      },
    });

    if (state === 'UNKNOWN') {
      summary.unknown += 1;
      await notifySendFailure(dispatch.id, result.error, correlationId);
    } else if (state === 'FAILED') {
      summary.failed += 1;
      await notifySendFailure(dispatch.id, result.error, correlationId);
    } else {
      summary.retried += 1;
    }
  }

  return summary;
}

/** Уведомление автора о том, что письмо не доставлено. */
async function notifySendFailure(
  dispatchId: string,
  error: string,
  correlationId: string,
): Promise<void> {
  const dispatch = await prisma.crmQuoteDispatch.findUnique({
    where: { id: dispatchId },
    select: { initiatedById: true, subject: true, queueState: true, errorText: true },
  });
  if (!dispatch) return;

  await prisma.$transaction(async (tx) => {
    await audit(tx, {
      serviceAccount: 'MAIL_WORKER',
      actionCode: AuditAction.QUOTE_MAIL_RESULT,
      entityType: 'CrmQuoteDispatch',
      entityId: dispatchId,
      applicationId: null,
      after: { queueState: dispatch.queueState, errorText: dispatch.errorText },
      correlationId,
    });
    await notify(tx, {
      userId: dispatch.initiatedById,
      code: NotifyCode.QUOTE_SEND_FAILED,
      title: `КП не отправлено: ${textOf(dispatch.subject, dispatchId)}`,
      body: error.slice(0, 500),
      entityType: 'CrmQuoteDispatch',
      entityId: dispatchId,
      dedupKey: `mail-failed:${dispatchId}:${dispatch.queueState}`,
    });
  });
}

/** Доставка событий для 1С. */
async function runOutboxQueue(correlationId: string): Promise<DeliverySummary['outbox']> {
  const summary = { delivered: 0, retried: 0, failed: 0 };
  // Приёмник 1С не настроен — события остаются PENDING, повторы не тратятся.
  if (!config.outboxTargetUrl) return summary;
  const due = await prisma.outboxMessage.findMany({
    where: { state: 'PENDING', nextAttemptAt: { lte: new Date() }, attempts: { lt: maxAttempts() } },
    orderBy: { createdAt: 'asc' },
    take: BATCH_LIMIT,
  });

  for (const message of due) {
    const claimed = await prisma.outboxMessage.updateMany({
      where: { id: message.id, state: 'PENDING' },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue;

    let body: unknown = message.payload;
    try {
      body = JSON.parse(message.payload) as unknown;
    } catch {
      body = message.payload;
    }

    const result = await deliverOutbox({
      id: message.id,
      eventType: message.eventType,
      objectType: message.objectType,
      extId: message.extId,
      applicationId: message.applicationId,
      versionNo: message.versionNo,
      body,
      attempts: message.attempts + 1,
    });

    const attempts = message.attempts + 1;
    if (result.ok) {
      await prisma.outboxMessage.update({
        where: { id: message.id },
        data: { state: 'DELIVERED', deliveredAt: new Date(), lastError: null },
      });
      summary.delivered += 1;
      await auditDelivery(message.id, message.applicationId, 'DELIVERED', null, correlationId);
      continue;
    }

    const exhausted = attempts >= maxAttempts();
    await prisma.outboxMessage.update({
      where: { id: message.id },
      data: {
        state: exhausted ? 'ERROR_QUEUE' : 'PENDING',
        lastError: result.error.slice(0, 1000),
        nextAttemptAt: new Date(Date.now() + nextBackoffMs(attempts)),
      },
    });
    if (exhausted) {
      summary.failed += 1;
      await auditDelivery(message.id, message.applicationId, 'ERROR_QUEUE', result.error, correlationId);
    } else {
      summary.retried += 1;
    }
  }

  return summary;
}

async function auditDelivery(
  id: string,
  applicationId: string | null,
  state: string,
  error: string | null,
  correlationId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await audit(tx, {
      serviceAccount: 'OUTBOX_WORKER',
      actionCode: AuditAction.INTEGRATION_DELIVERY,
      entityType: 'OutboxMessage',
      entityId: id,
      applicationId,
      after: { state, error },
      correlationId,
    });
  });
}

/** Один прогон обеих очередей. */
export async function runDeliveryQueues(correlationId = newCorrelationId()): Promise<DeliverySummary> {
  const configured = deliveryConfigured();
  const [mail, outbox] = await Promise.all([runMailQueue(correlationId), runOutboxQueue(correlationId)]);
  return { mail, outbox, skipped: !configured.mail && !configured.outbox };
}

export function deliveryConfigured(): { mail: boolean; outbox: boolean } {
  return {
    mail: Boolean(config.mailTransportUrl),
    outbox: Boolean(config.outboxTargetUrl),
  };
}