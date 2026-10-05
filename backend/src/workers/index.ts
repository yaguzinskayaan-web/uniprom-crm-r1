import type { FastifyBaseLogger } from 'fastify';
import { newCorrelationId, config } from '../config.js';
import { evaluateSlaBreaches } from '../services/sla.js';
import { runDeliveryQueues, deliveryConfigured } from '../services/delivery.js';

/**
 * Фоновые задачи. Один процесс, один таймер на задачу:
 *  - SLA-01 (эскалация просрочек);
 *  - A19/A45 — доставка очередей: писем с КП и событий для 1С.
 *
 * Доставка без настроенного транспорта не выполняется и не имитируется:
 * задание остаётся в очереди, а его возраст виден в разделе интеграций.
 */

interface WorkerHandle {
  name: string;
  stop: () => void;
}

const timers: NodeJS.Timeout[] = [];
const handles: WorkerHandle[] = [];

const SLA_INTERVAL_MS = 60_000;

export function startWorkers(log: FastifyBaseLogger): void {
  if (timers.length) return;

  const runSla = () => {
    const correlationId = newCorrelationId();
    evaluateSlaBreaches(correlationId)
      .then((r) => {
        if (r.checked) log.info({ checked: r.checked, correlationId }, 'SLA: проверены экземпляры контроля');
      })
      .catch((err: unknown) => log.error({ err, correlationId }, 'SLA: ошибка фоновой проверки'));
  };

  const slaTimer = setInterval(runSla, SLA_INTERVAL_MS);
  slaTimer.unref();
  timers.push(slaTimer);
  handles.push({ name: 'sla-breaches', stop: () => clearInterval(slaTimer) });

  // Первый прогон сразу после старта
  setTimeout(runSla, 2_000).unref();

  const runDelivery = () => {
    const correlationId = newCorrelationId();
    runDeliveryQueues(correlationId)
      .then((r) => {
        const touched = r.mail.sent + r.mail.retried + r.mail.unknown + r.mail.failed + r.outbox.delivered + r.outbox.retried + r.outbox.failed;
        if (touched > 0) log.info({ ...r, correlationId }, 'Очереди доставки обработаны');
      })
      .catch((err: unknown) => log.error({ err, correlationId }, 'Очереди доставки: ошибка'));
  };

  const deliveryTimer = setInterval(runDelivery, config.deliveryIntervalMs);
  deliveryTimer.unref();
  timers.push(deliveryTimer);
  handles.push({ name: 'delivery-queues', stop: () => clearInterval(deliveryTimer) });

  setTimeout(runDelivery, 5_000).unref();

  const transport = deliveryConfigured();
  log.info(
    {
      workers: handles.map((h) => h.name),
      deliveryIntervalMs: config.deliveryIntervalMs,
      mailTransport: transport.mail ? 'настроен' : 'не настроен',
      outboxTarget: transport.outbox ? 'настроен' : 'не настроен',
    },
    'Фоновые задачи запущены',
  );
}

export function stopWorkers(): void {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  handles.length = 0;
}
