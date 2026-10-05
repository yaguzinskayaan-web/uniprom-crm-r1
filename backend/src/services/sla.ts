import { prisma } from '../lib/prisma.js';
import type { Tx } from '../errors.js';
import { AppError, ErrorCode } from '../errors.js';
import { audit, AuditAction } from '../lib/audit.js';
import { notify, NotifyCode, escalationRecipients } from '../lib/notifications.js';
import { csv, jparse, parsePage } from '../lib/query.js';
import { P, assertPermission } from '../domain/rbac.js';
import type { Principal } from '../domain/scope.js';
import type { Complexity, Stage } from '../domain/constants.js';

type Client = Tx | typeof prisma;

export const SlaCode = {
  FIRST_RESPONSE: 'FIRST_RESPONSE',
  KO_PREQUOTE: 'KO_PREQUOTE',
  QUOTE_PREPARATION: 'QUOTE_PREPARATION',
  QUOTE_APPROVAL: 'QUOTE_APPROVAL',
  FOLLOW_UP_CONTACT: 'FOLLOW_UP_CONTACT',
} as const;

const MINUTE = 60_000;

// ─────────────────────────── Календарь рабочего времени (SLA-02)

export interface CalendarShape {
  timezone: string;
  weekdays: number[]; // 1 = понедельник … 7 = воскресенье
  workStart: string;
  workEnd: string;
  holidays: string[]; // YYYY-MM-DD
}

export async function loadDefaultCalendar(client: Client = prisma): Promise<CalendarShape> {
  const cal = await client.workCalendar.findFirst({ where: { isDefault: true } });
  if (!cal) {
    return { timezone: 'Asia/Yekaterinburg', weekdays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '18:00', holidays: [] };
  }
  return {
    timezone: cal.timezone,
    weekdays: jparse<number[]>(cal.weekdays, [1, 2, 3, 4, 5]),
    workStart: cal.workStart,
    workEnd: cal.workEnd,
    holidays: jparse<string[]>(cal.holidays, []),
  };
}

function minutesOfDay(iso: string): number {
  const [h, m] = iso.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Прибавляет интервал рабочего времени к моменту. Если правило использует
 * календарные часы (usesBusinessHours = false) — прибавляет обычные часы.
 * SLA-02: для каждого правила явно определено, рабочие или календарные часы.
 */
export function addWorkingMinutes(from: Date, minutes: number, cal: CalendarShape, businessHours: boolean): Date {
  if (!businessHours) return new Date(from.getTime() + minutes * MINUTE);

  const startMin = minutesOfDay(cal.workStart);
  const endMin = minutesOfDay(cal.workEnd);
  const dayLen = Math.max(0, endMin - startMin);
  if (dayLen === 0) return new Date(from.getTime() + minutes * MINUTE);

  let remaining = minutes;
  const cursor = new Date(from);

  for (let guard = 0; guard < 400 && remaining > 0; guard += 1) {
    // Продвигаем к началу рабочего дня, если сейчас нерабочее время
    const isoDay = cursor.toISOString().slice(0, 10);
    const dow = isoToDayOfWeek(cursor);
    const isWorkDay = cal.weekdays.includes(dow) && !cal.holidays.includes(isoDay);

    if (!isWorkDay) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const curMin = cursor.getUTCHours() * 60 + cursor.getUTCMinutes();
    if (curMin < startMin) {
      cursor.setUTCHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
      continue;
    }
    if (curMin >= endMin) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const availableToday = endMin - curMin;
    if (remaining <= availableToday) {
      return new Date(cursor.getTime() + remaining * MINUTE);
    }
    remaining -= availableToday;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(0, 0, 0, 0);
  }
  return new Date(cursor.getTime() + remaining * MINUTE);
}

function isoToDayOfWeek(d: Date): number {
  const wd = d.getUTCDay(); // 0 = воскресенье
  return wd === 0 ? 7 : wd;
}

// ─────────────────────────── Экземпляры контроля

export async function refreshSlaForStage(
  client: Client,
  applicationId: string,
  stage: Stage,
  complexity: string,
  ownerId?: string | null,
): Promise<void> {
  const rules = await client.slaRule.findMany({ where: { isActive: true, stage } });
  if (!rules.length) return;
  const cal = await loadDefaultCalendar(client);

  const app = await client.application.findUnique({
    where: { id: applicationId },
    select: { ownerId: true, number: true, priority: true },
  });
  if (!app) return;
  const assigneeId = ownerId ?? app.ownerId;

  for (const rule of rules) {
    if (rule.complexity && rule.complexity !== 'ANY' && rule.complexity !== complexity) continue;
    if (rule.priority && rule.priority !== 'ANY' && rule.priority !== app.priority) continue;

    // SLA-04: новая редакция норматива применяется к новым экземплярам контроля
    const existing = await client.slaInstance.findFirst({
      where: { applicationId, ruleCode: rule.code, status: 'ACTIVE' },
    });
    if (existing) continue;

    const startedAt = new Date();
    const dueAt = addWorkingMinutes(startedAt, rule.durationMinutes, cal, rule.usesBusinessHours);
    await client.slaInstance.create({
      data: {
        applicationId,
        ruleCode: rule.code,
        dueAt,
        originalDueAt: dueAt,
        startedAt,
        assigneeId,
        stage,
        complexity,
      },
    });
  }
}

export async function startSla(
  client: Client,
  applicationId: string,
  ruleCode: string,
  assigneeId: string | null,
  stage: string,
  complexity: string,
): Promise<void> {
  const rule = await client.slaRule.findFirst({ where: { code: ruleCode, isActive: true } });
  if (!rule) return;
  const cal = await loadDefaultCalendar(client);
  const now = new Date();
  const dueAt = addWorkingMinutes(now, rule.durationMinutes, cal, rule.usesBusinessHours);
  await client.slaInstance.create({
    data: {
      applicationId,
      ruleCode: rule.code,
      dueAt,
      originalDueAt: dueAt,
      startedAt: now,
      assigneeId,
      stage,
      complexity,
    },
  });
}

/** Завершение норматива при достижении целевого действия. */
export async function completeSla(client: Client, applicationId: string, ruleCodes: string[]): Promise<void> {
  if (!ruleCodes.length) return;
  await client.slaInstance.updateMany({
    where: { applicationId, ruleCode: { in: ruleCodes }, status: 'ACTIVE' },
    data: { status: 'MET' },
  });
}

/**
 * SLA-03: ожидание ответа клиента может приостанавливать только те нормативы,
 * для которых это разрешено. Пауза не скрывает просрочку, возникшую раньше.
 */
export async function pauseSla(input: {
  applicationId: string;
  ruleCodes: string[];
  reason: string;
  awaiting: string;
  nextCheckAt: string;
  correlationId: string;
  actor: Principal;
}) {
  const rules = await prisma.slaRule.findMany({ where: { code: { in: input.ruleCodes } } });
  const pausable = rules.filter((r) => r.pauseOnCustomerWait);
  if (!pausable.length) {
    return { paused: 0, skipped: input.ruleCodes.length };
  }
  const instances = await prisma.slaInstance.findMany({
    where: {
      applicationId: input.applicationId,
      ruleCode: { in: pausable.map((r) => r.code) },
      status: 'ACTIVE',
    },
  });
  let paused = 0;
  for (const inst of instances) {
    // Пауза не скрывает просрочку, возникшую раньше
    const alreadyBreached = inst.dueAt.getTime() < Date.now();
    await prisma.$transaction(async (tx) => {
      await tx.slaInstance.update({
        where: { id: inst.id },
        data: { status: alreadyBreached ? 'BREACHED' : 'PAUSED' },
      });
      await tx.slaPause.create({
        data: {
          slaInstanceId: inst.id,
          reason: input.reason,
          awaiting: input.awaiting,
          nextCheckAt: new Date(input.nextCheckAt),
          startedById: input.actor.id,
        },
      });
    });
    paused += 1;
    await audit(prisma, {
      actor: input.actor,
      actionCode: AuditAction.SLA_PAUSE,
      entityType: 'SlaInstance',
      entityId: inst.id,
      applicationId: input.applicationId,
      after: { reason: input.reason, awaiting: input.awaiting, nextCheckAt: input.nextCheckAt },
      correlationId: input.correlationId,
    });
  }
  return { paused, skipped: input.ruleCodes.length - paused };
}

/**
 * Возобновление сохраняет исходный срок и причину изменения (SLA-03).
 * Возобновление сдвигает dueAt на фактически потерянное время.
 */
export async function resumeSla(instanceId: string, correlationId: string, actor: Principal) {
  const inst = await prisma.slaInstance.findUnique({
    where: { id: instanceId },
    include: { pauses: { where: { endedAt: null }, orderBy: { startedAt: 'desc' } } },
  });
  if (!inst) return null;
  const pause = inst.pauses[0];
  if (!pause) return inst;

  const now = new Date();
  const pausedMs = pause.startedAt.getTime() < now.getTime() ? now.getTime() - pause.startedAt.getTime() : 0;
  // Возобновление и перенос срока сохраняют исходный срок и причину изменения
  const newDue = new Date(inst.dueAt.getTime() + pausedMs);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.slaPause.updateMany({ where: { slaInstanceId: inst.id, endedAt: null }, data: { endedAt: now } });
    return tx.slaInstance.update({
      where: { id: inst.id },
      data: { dueAt: newDue, pausedMs: { increment: pausedMs }, status: 'ACTIVE' },
    });
  });

  await audit(prisma, {
    actor,
    actionCode: AuditAction.SLA_RESUME,
    entityType: 'SlaInstance',
    entityId: inst.id,
    applicationId: inst.applicationId,
    before: { dueAt: inst.dueAt.toISOString(), status: inst.status },
    after: { dueAt: newDue.toISOString(), status: 'ACTIVE', originalDueAt: inst.originalDueAt.toISOString() },
    payload: { reason: pause.reason, awaiting: pause.awaiting, pausedMs },
    correlationId,
  });
  return updated;
}

// ─────────────────────────── Фоновая проверка просрочек

/**
 * SLA-01: при просрочке уведомляются исполнитель и соответствующий руководитель.
 * Уведомления дедуплицируются (SLA_BREACH:<instanceId>).
 */
export async function evaluateSlaBreaches(correlationId: string) {
  const now = new Date();
  const overdue = await prisma.slaInstance.findMany({
    where: { status: { in: ['ACTIVE', 'PAUSED'] }, dueAt: { lt: now } },
    include: { application: { select: { number: true, ownerId: true, complexity: true } } },
    take: 200,
  });

  const ruleRoles: Record<string, 'SALES_MANAGER' | 'DESIGN_MANAGER'> = {
    [SlaCode.FIRST_RESPONSE]: 'SALES_MANAGER',
    [SlaCode.QUOTE_PREPARATION]: 'SALES_MANAGER',
    [SlaCode.QUOTE_APPROVAL]: 'SALES_MANAGER',
    [SlaCode.FOLLOW_UP_CONTACT]: 'SALES_MANAGER',
    [SlaCode.KO_PREQUOTE]: 'DESIGN_MANAGER',
  };

  for (const inst of overdue) {
    if (inst.status === 'BREACHED') continue;
    await prisma.slaInstance.update({
      where: { id: inst.id },
      data: { status: 'BREACHED', breachedAt: now },
    });
    const role = ruleRoles[inst.ruleCode] ?? 'SALES_MANAGER';
    const recipients = await escalationRecipients(prisma, inst.assigneeId, role);
    const days = Math.max(0, Math.round((now.getTime() - inst.dueAt.getTime()) / 86400_000));
    for (const userId of recipients) {
      await notify(prisma, {
        userId,
        code: NotifyCode.SLA_BREACH,
        title: `Просрочен норматив: ${inst.ruleCode}`,
        body: `Заявка ${inst.application.number}${days ? `, просрочка ${days} дн.` : ''}`,
        entityType: 'Application',
        entityId: inst.applicationId,
        dedupKey: `sla-breach:${inst.id}`,
      });
    }
    await audit(prisma, {
      serviceAccount: 'SLA_WORKER',
      actionCode: AuditAction.SLA_BREACH,
      entityType: 'SlaInstance',
      entityId: inst.id,
      applicationId: inst.applicationId,
      payload: { ruleCode: inst.ruleCode, dueAt: inst.dueAt.toISOString(), recipients },
      correlationId,
    });
  }
  return { checked: overdue.length };
}

// ─────────────────────────── Администрирование нормативов

export async function listSlaRules() {
  return prisma.slaRule.findMany({ orderBy: { code: 'asc' } });
}

export async function upsertSlaRule(
  input: Partial<{
    id: string;
    code: string;
    name: string;
    stage: string;
    complexity: string;
    priority: string;
    usesBusinessHours: boolean;
    durationMinutes: number;
    remindBeforeMinutes: number;
    escalationUserId?: string | null;
    pauseOnCustomerWait: boolean;
  }>,
  actor: Principal,
  correlationId: string,
) {
  assertPermission(actor.role as never, P.SLA_WRITE);
  if (!input.code || !input.name) {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Укажите код и название норматива', {
      fields: [
        ...(input.code ? [] : [{ field: 'code', message: 'Обязательное поле' }]),
        ...(input.name ? [] : [{ field: 'name', message: 'Обязательное поле' }]),
      ],
    });
  }
  const data = {
    code: input.code,
    name: input.name,
    stage: input.stage ?? null,
    complexity: input.complexity ?? 'ANY',
    priority: input.priority ?? 'ANY',
    usesBusinessHours: input.usesBusinessHours ?? true,
    durationMinutes: input.durationMinutes ?? 1440,
    remindBeforeMinutes: input.remindBeforeMinutes ?? 120,
    escalationUserId: input.escalationUserId ?? null,
    pauseOnCustomerWait: input.pauseOnCustomerWait ?? false,
    versionNo: 1,
  };
  const row = input.id
    ? await prisma.slaRule.update({ where: { id: input.id }, data: { ...data, versionNo: { increment: 1 } } })
    : await prisma.slaRule.create({ data });

  await audit(prisma, {
    actor,
    actionCode: AuditAction.SLA_RULE_UPDATE,
    entityType: 'SlaRule',
    entityId: row.id,
    before: input.id ? { versionNo: row.versionNo - 1 } : null,
    after: data,
    correlationId,
  });
  return row;
}

export async function listCalendars() {
  return prisma.workCalendar.findMany({ orderBy: { createdAt: 'asc' } });
}

export async function upsertCalendar(
  input: {
    id?: string;
    name: string;
    timezone: string;
    weekdays: number[];
    workStart: string;
    workEnd: string;
    holidays: string[];
    isDefault: boolean;
  },
  actor: Principal,
  correlationId: string,
) {
  assertPermission(actor.role as never, P.ADMIN_CALENDAR);
  const data = {
    name: input.name,
    timezone: input.timezone,
    weekdays: JSON.stringify(input.weekdays),
    workStart: input.workStart,
    workEnd: input.workEnd,
    holidays: JSON.stringify(input.holidays),
    isDefault: input.isDefault,
  };
  const row = input.id
    ? await prisma.workCalendar.update({ where: { id: input.id }, data })
    : await prisma.workCalendar.create({ data });

  if (input.isDefault) {
    await prisma.workCalendar.updateMany({ where: { id: { not: row.id } }, data: { isDefault: false } });
  }
  await audit(prisma, {
    actor,
    actionCode: AuditAction.CALENDAR_UPDATE,
    entityType: 'WorkCalendar',
    entityId: row.id,
    after: input,
    correlationId,
  });
  return row;
}

export async function listSlaInstances(query: Record<string, unknown>) {
  const page = parsePage(query);
  const statuses = csv(query, 'status');
  const where = {
    ...(statuses.length ? { status: { in: statuses } } : {}),
    ...(query.overdue === 'true' ? { dueAt: { lt: new Date() } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.slaInstance.findMany({
      where,
      orderBy: { dueAt: 'asc' },
      skip: page.offset,
      take: page.size,
      include: {
        application: { select: { number: true, organization: { select: { name: true } }, owner: { select: { id: true, fullName: true } } } },
        pauses: true,
      },
    }),
    prisma.slaInstance.count({ where }),
  ]);
  return { items, total, page: page.page, size: page.size };
}

export type { Complexity };
