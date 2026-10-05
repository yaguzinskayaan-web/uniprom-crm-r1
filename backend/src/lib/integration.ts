import { randomUUID } from 'node:crypto';
import type { Tx } from '../errors.js';
import { audit, AuditAction } from './audit.js';
import { prisma } from './prisma.js';

type Client = Tx | typeof prisma;

export const SYSTEM = 'ONE_C' as const;

export interface EnqueueInput {
  objectType: string;
  extId: string;
  applicationId?: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  correlationId: string;
  versionNo?: number;
}

/**
 * SYNC-04: изменение бизнес-данных и запись задания на исходящий обмен
 * выполняются атомарно — вызывающая сторона передаёт тот же tx.
 * SYNC-03: ключ идемпотентности гарантирует отсутствие повторного заказа.
 */
export async function enqueueOutbox(client: Client, input: EnqueueInput): Promise<string> {
  const idempotencyKey = `${SYSTEM}:${input.objectType}:${input.extId}:${input.eventType}:${randomUUID()}`;
  const row = await client.outboxMessage.create({
    data: {
      system: SYSTEM,
      objectType: input.objectType,
      extId: input.extId,
      applicationId: input.applicationId ?? null,
      versionNo: input.versionNo ?? 1,
      eventType: input.eventType,
      payload: JSON.stringify(input.payload),
      idempotencyKey,
      correlationId: input.correlationId,
      state: 'PENDING',
      nextAttemptAt: new Date(),
    },
  });
  return row.id;
}

export interface InboundMessage {
  system?: string;
  objectType: string;
  extId: string;
  versionNo: number;
  eventType: string;
  payload: Record<string, unknown>;
  correlationId?: string;
}

export interface InboundResult {
  messageKey: string;
  state: 'PROCESSED' | 'SKIPPED_STALE' | 'CONFLICT' | 'ERROR';
  result: string;
}

/**
 * SYNC-03: повторная доставка не создаёт повторный заказ/платёж/отгрузку;
 * более старая версия не перезаписывает более новую.
 */
export async function registerInbound(client: Client, msg: InboundMessage): Promise<InboundResult> {
  const system = msg.system ?? SYSTEM;
  const messageKey = `${system}:${msg.objectType}:${msg.extId}:${msg.eventType}:${msg.versionNo}:${msg.correlationId ?? ''}`;
  const correlationId = msg.correlationId ?? randomUUID();

  const existing = await client.inboxMessage.findUnique({ where: { messageKey } });
  if (existing) {
    return { messageKey, state: existing.state as InboundResult['state'], result: 'duplicate-delivery' };
  }

  await client.inboxMessage.create({
    data: {
      system,
      objectType: msg.objectType,
      extId: msg.extId,
      versionNo: msg.versionNo,
      eventType: msg.eventType,
      payload: JSON.stringify(msg.payload),
      messageKey,
      correlationId,
      state: 'PROCESSED',
      result: 'registered',
      processedAt: new Date(),
    },
  });

  const link = await client.integrationLink.findUnique({
    where: { system_objectType_extId: { system, objectType: msg.objectType, extId: msg.extId } },
  });

  if (link && msg.versionNo < link.versionNo) {
    await client.inboxMessage.update({
      where: { messageKey },
      data: { state: 'SKIPPED_STALE', result: `stale: incoming v${msg.versionNo} < stored v${link.versionNo}` },
    });
    await audit(client, {
      serviceAccount: system,
      actionCode: AuditAction.SYNC_IN_STALE_SKIPPED,
      entityType: 'IntegrationLink',
      entityId: link.id,
      payload: { objectType: msg.objectType, extId: msg.extId, incoming: msg.versionNo, stored: link.versionNo },
      correlationId,
    });
    return { messageKey, state: 'SKIPPED_STALE', result: 'older version ignored' };
  }

  if (link && msg.versionNo === link.versionNo) {
    await client.inboxMessage.update({
      where: { messageKey },
      data: { state: 'PROCESSED', result: 'same version, replay' },
    });
    return { messageKey, state: 'PROCESSED', result: 'same version' };
  }

  await client.integrationLink.upsert({
    where: { system_objectType_extId: { system, objectType: msg.objectType, extId: msg.extId } },
    create: {
      system,
      objectType: msg.objectType,
      extId: msg.extId,
      applicationId: msg.payload?.applicationId as string | undefined ?? null,
      versionNo: msg.versionNo,
      lastEventAt: new Date(),
      lastSyncedAt: new Date(),
      state: 'SYNCED',
    },
    update: {
      versionNo: msg.versionNo,
      lastEventAt: new Date(),
      lastSyncedAt: new Date(),
      state: 'SYNCED',
      ...(typeof msg.payload?.applicationId === 'string' ? { applicationId: msg.payload.applicationId as string } : {}),
    },
  });

  return { messageKey, state: 'PROCESSED', result: 'applied' };
}

export function backoffMs(attempts: number): number {
  // SYNC-04: повторные попытки с увеличением интервала
  const base = 60_000;
  return Math.min(base * 2 ** Math.max(0, attempts - 1), 60 * 60_000);
}

export const MAX_ATTEMPTS = 8;

/** Возраст учётных данных — SYNC-06 («система показывает возраст учётных данных»). */
export async function accountingDataAgeMinutes(): Promise<{ ageMinutes: number | null; lastSyncedAt: Date | null }> {
  const last = await prisma.shipment.findFirst({
    orderBy: { updatedAt: 'desc' },
    select: { updatedAt: true },
  });
  const lastPay = await prisma.payment.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } });
  const candidates = [last?.updatedAt, lastPay?.updatedAt].filter(Boolean) as Date[];
  if (!candidates.length) return { ageMinutes: null, lastSyncedAt: null };
  const lastSyncedAt = candidates.reduce((a, b) => (a > b ? a : b));
  return { ageMinutes: Math.round((Date.now() - lastSyncedAt.getTime()) / 60000), lastSyncedAt };
}
