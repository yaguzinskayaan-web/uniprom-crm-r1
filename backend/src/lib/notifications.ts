import type { Tx } from '../errors.js';
import { prisma } from './prisma.js';

type Client = Tx | typeof prisma;

export const NotifyCode = {
  APPLICATION_ASSIGNED: 'APPLICATION_ASSIGNED',
  APPLICATION_REASSIGNED: 'APPLICATION_REASSIGNED',
  APPLICATION_CREATED: 'APPLICATION_CREATED',
  APPLICATION_STAGE_CHANGED: 'APPLICATION_STAGE_CHANGED',
  APPLICATION_RETURNED_FOR_CLARIFICATION: 'APPLICATION_RETURNED_FOR_CLARIFICATION',
  APPLICATION_CLOSED: 'APPLICATION_CLOSED',
  APPLICATION_CLOSE_REOPENED: 'APPLICATION_CLOSE_REOPENED',
  CRITICAL_TERMS_CHANGED: 'CRITICAL_TERMS_CHANGED',
  TASK_DUE_TODAY: 'TASK_DUE_TODAY',
  TASK_DUE_SOON: 'TASK_DUE_SOON',
  TASK_OVERDUE: 'TASK_OVERDUE',
  TASK_ASSIGNED: 'TASK_ASSIGNED',
  QUOTE_APPROVAL_REQUESTED: 'QUOTE_APPROVAL_REQUESTED',
  QUOTE_APPROVED: 'QUOTE_APPROVED',
  QUOTE_REJECTED: 'QUOTE_REJECTED',
  QUOTE_SENT: 'QUOTE_SENT',
  QUOTE_SEND_FAILED: 'QUOTE_SEND_FAILED',
  ENG_TASK_ASSIGNED: 'ENG_TASK_ASSIGNED',
  ENG_TASK_RETURNED: 'ENG_TASK_RETURNED',
  ENG_CONCLUSION_SUBMITTED: 'ENG_CONCLUSION_SUBMITTED',
  ENG_CONCLUSION_NEEDS_DATA: 'ENG_CONCLUSION_NEEDS_DATA',
  PRODUCTION_RELEASED: 'PRODUCTION_RELEASED',
  SLA_BREACH: 'SLA_BREACH',
  SLA_DUE_SOON: 'SLA_DUE_SOON',
  MAIL_QUEUED: 'MAIL_QUEUED',
  INTEGRATION_ERROR: 'INTEGRATION_ERROR',
  IMPORT_RESULT: 'IMPORT_RESULT',
} as const;

export interface NotifyInput {
  userId: string;
  code: string;
  title: string;
  body?: string | null;
  entityType?: string;
  entityId?: string;
  /**
   * Ключ дедупликации (§10.3 «уведомления дедуплицируются»). Повтор с тем же
   * ключом не создаёт второе уведомление.
   */
  dedupKey: string;
}

/** Внутренние уведомления. Не заменяют задачи. */
export async function notify(client: Client, input: NotifyInput): Promise<void> {
  await client.notification.upsert({
    where: { userId_dedupKey: { userId: input.userId, dedupKey: input.dedupKey } },
    create: {
      userId: input.userId,
      code: input.code,
      title: input.title,
      body: input.body ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      dedupKey: input.dedupKey,
    },
    update: {},
  });
}

export async function notifyMany(client: Client, userIds: string[], input: Omit<NotifyInput, 'userId'>): Promise<void> {
  const unique = [...new Set(userIds.filter(Boolean))];
  for (const userId of unique) await notify(client, { ...input, userId });
}

/** Руководители, получающие эскалацию по просрочке (исполнитель + руководитель, §10.3). */
export async function escalationRecipients(
  client: Client,
  assigneeId: string | null,
  role: 'SALES_MANAGER' | 'DESIGN_MANAGER' | 'ADMIN',
): Promise<string[]> {
  const leaders = await client.user.findMany({
    where: { role, isActive: true, blockedAt: null },
    select: { id: true },
  });
  return [...(assigneeId ? [assigneeId] : []), ...leaders.map((l) => l.id)];
}
