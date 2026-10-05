import { prisma } from '../lib/prisma.js';
import { ErrorCode, badRequest, forbidden, notFound, conflict } from '../errors.js';
import { audit, AuditAction } from '../lib/audit.js';
import { notify, NotifyCode } from '../lib/notifications.js';
import { P, assertPermission, permissionsFor } from '../domain/rbac.js';
import { assertCanReadApplicationInScope, applyScope, type Principal } from '../domain/scope.js';
import { ACTIVITY_TYPES, TASK_TYPES } from '../domain/constants.js';
import { csv, dateParam, numParam, parsePage, q } from '../lib/query.js';
import { computeNextActivity } from './applications.js';

/**
 * Задачи и бизнес-хронология (§10.1).
 *
 *  • last_activity_at отражает зарегистрированное бизнес-событие: технический
 *    опрос интеграции его не освежает (isCustomerFacing=false);
 *  • для контроля отсутствия контакта используется last_customer_contact_at —
 *    дата последней содержательной коммуникации с клиентом;
 *  • next_activity_at пересчитывается при создании, изменении, отмене и
 *    завершении задачи;
 *  • коррекция коммуникации сохраняет предыдущее значение и автора правки.
 */

export interface ListTasksParams {
  page: ReturnType<typeof parsePage>;
  assigneeId?: string;
  status?: string[];
  type?: string[];
  applicationId?: string;
  /** Номер заявки из контрактного маршрута `/crm/applications/{number}/tasks`. */
  applicationNumber?: string;
  dueFrom?: Date;
  dueTo?: Date;
  onlyOverdue?: boolean;
  onlyToday?: boolean;
}

// ─────────────────────────── Задачи

export async function listTasks(params: ListTasksParams, p: Principal) {
  assertPermission(p.role as never, P.TASK_READ_ANY);
  const where: Record<string, unknown> = {};
  // RBAC-01/02: задачи наследуют область видимости своей заявки, поэтому в
  // выборку не попадают задачи по чужим или невидимым заявкам.
  const canReadAnyApp = permissionsFor(p.role as never).includes(P.APPLICATION_READ_ANY);
  if (!canReadAnyApp) where.application = { is: applyScope({}, p) };
  if (params.status?.length) where.status = { in: params.status };
  if (params.type?.length) where.type = { in: params.type };
  if (params.applicationId) where.applicationId = params.applicationId;
  if (params.applicationNumber) {
    const app = await prisma.application.findUnique({ where: { number: params.applicationNumber }, select: { id: true } });
    if (!app) throw notFound('Заявка');
    where.applicationId = app.id;
  }
  if (params.assigneeId) where.assigneeId = params.assigneeId;
  if (params.dueFrom || params.dueTo) {
    where.dueAt = {
      ...(params.dueFrom ? { gte: params.dueFrom } : {}),
      ...(params.dueTo ? { lte: params.dueTo } : {}),
    };
  }
  if (params.onlyOverdue) {
    where.status = 'OPEN';
    where.dueAt = { lt: new Date() };
  }
  if (params.onlyToday) {
    const from = startOfDay();
    const to = new Date(from.getTime() + 86400_000);
    where.dueAt = { gte: from, lt: to };
  }

  const [total, rows] = await Promise.all([
    prisma.crmTask.count({ where }),
    prisma.crmTask.findMany({
      where,
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { id: 'asc' }],
      skip: params.page.offset,
      take: params.page.size,
      include: {
        assignee: { select: { id: true, fullName: true, role: true } },
        author: { select: { id: true, fullName: true } },
        application: { select: { id: true, number: true, stage: true, organization: { select: { name: true } } } },
      },
    }),
  ]);

  return { items: rows, total, page: params.page.page, size: params.page.size };
}

export function parseTaskListQuery(query: Record<string, unknown>): ListTasksParams {
  const onlyOverdue = query.overdue === 'true';
  const onlyToday = query.today === 'true';
  return {
    page: parsePage(query),
    assigneeId: q(query, 'assigneeId'),
    status: csv(query, 'status'),
    type: csv(query, 'type'),
    applicationId: q(query, 'applicationId'),
    applicationNumber: q(query, 'applicationNumber'),
    dueFrom: dateParam(query, 'dueFrom'),
    dueTo: dateParam(query, 'dueTo'),
    onlyOverdue,
    onlyToday,
  };
}

function startOfDay(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export interface CreateTaskInput {
  applicationNumber: string;
  type: string;
  subject: string;
  description?: string;
  assigneeId: string;
  dueAt: string;
  priority?: string;
  contactId?: string | null;
  reminderAt?: string | null;
  correlationId: string;
  actor: Principal;
}

export async function createTask(input: CreateTaskInput) {
  const { actor, correlationId } = input;
  assertPermission(actor.role as never, P.TASK_CREATE);
  if (!(TASK_TYPES as readonly string[]).includes(input.type)) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Неизвестный тип задачи', {
      fields: [{ field: 'type', message: 'Выберите значение из справочника' }],
    });
  }
  if (!input.subject?.trim()) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Укажите тему задачи', {
      fields: [{ field: 'subject', message: 'Обязательное поле' }],
    });
  }

  const app = await prisma.application.findUnique({ where: { number: input.applicationNumber }, select: { id: true, number: true, ownerId: true } });
  if (!app) throw notFound('Заявка');
  await assertCanReadApplicationInScope(
    app,
    actor,
    permissionsFor(actor.role as never).includes(P.APPLICATION_READ_ANY),
  );
  await assertAssigneeActive(input.assigneeId, 'assigneeId');

  const row = await prisma.$transaction(async (tx) => {
    const task = await tx.crmTask.create({
      data: {
        applicationId: app.id,
        type: input.type,
        subject: input.subject.trim(),
        description: input.description ?? null,
        authorId: actor.id,
        assigneeId: input.assigneeId,
        dueAt: new Date(input.dueAt),
        status: 'OPEN',
        priority: input.priority ?? 'NORMAL',
        contactId: input.contactId ?? null,
        reminderAt: input.reminderAt ? new Date(input.reminderAt) : null,
        lockVersion: 1,
      },
    });

    await tx.application.update({
      where: { id: app.id },
      data: { nextActivityAt: await computeNextActivity(app.id, tx) },
    });

    await audit(tx, {
      actor,
      actionCode: AuditAction.TASK_CREATE,
      entityType: 'CrmTask',
      entityId: task.id,
      applicationId: app.id,
      after: { type: task.type, subject: task.subject, assigneeId: task.assigneeId, dueAt: task.dueAt },
      correlationId,
    });

    await notify(tx, {
      userId: input.assigneeId,
      code: NotifyCode.TASK_ASSIGNED,
      title: `Новая задача по заявке ${app.number}`,
      body: task.subject,
      entityType: 'CrmTask',
      entityId: task.id,
      dedupKey: `task-assigned:${task.id}:${input.assigneeId}`,
    });

    return task;
  });

  return row;
}

async function assertAssigneeActive(userId: string, field: string): Promise<void> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, blockedAt: true } });
  if (!u) throw notFound('Пользователь');
  if (!u.isActive || u.blockedAt) {
    throw badRequest(ErrorCode.ASSIGNEE_INACTIVE, 'Задачу можно назначить только активному пользователю', {
      fields: [{ field, message: 'Пользователь не активен' }],
    });
  }
}

/**
 * Задача наследует область видимости заявки: переназначенный или оставшийся
 * исполнителем сотрудник не должен видеть и менять задачи по заявке, которая
 * вышла из его области (RBAC-01, RBAC-02).
 */
async function assertTaskApplicationVisible(applicationId: string, actor: Principal): Promise<void> {
  if (permissionsFor(actor.role as never).includes(P.APPLICATION_READ_ANY)) return;
  const app = await prisma.application.findFirst({
    where: { AND: [{ id: applicationId }, applyScope({}, actor)] },
    select: { id: true },
  });
  if (!app) throw notFound('Заявка');
}

export interface UpdateTaskInput {
  id: string;
  lockVersion: number;
  subject?: string;
  description?: string | null;
  assigneeId?: string;
  dueAt?: string;
  priority?: string;
  reminderAt?: string | null;
  correlationId: string;
  actor: Principal;
}

export async function updateTask(input: UpdateTaskInput) {
  const { actor, correlationId } = input;
  const current = await prisma.crmTask.findUnique({ where: { id: input.id } });
  if (!current) throw notFound('Задача');
  if (current.status !== 'OPEN') {
    throw badRequest(ErrorCode.RESOURCE_LOCKED, 'Изменению доступна только открытая задача');
  }
  const canAny = permissionsFor(actor.role as never).includes(P.TASK_UPDATE_ANY);
  if (!canAny && current.assigneeId !== actor.id) {
    throw forbidden('Изменить задачу может её исполнитель или администратор');
  }
  if (!canAny) await assertTaskApplicationVisible(current.applicationId, actor);
  if (current.lockVersion !== input.lockVersion) {
    throw conflict(ErrorCode.VERSION_CONFLICT, 'Задача изменена другим пользователем. Обновите и повторите.', {
      details: { currentVersion: current.lockVersion, yourVersion: input.lockVersion },
    });
  }
  if (input.assigneeId) await assertAssigneeActive(input.assigneeId, 'assigneeId');

  return prisma.$transaction(async (tx) => {
    const task = await tx.crmTask.update({
      where: { id: current.id },
      data: {
        ...(input.subject !== undefined ? { subject: input.subject.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
        ...(input.dueAt !== undefined ? { dueAt: new Date(input.dueAt) } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.reminderAt !== undefined ? { reminderAt: input.reminderAt ? new Date(input.reminderAt) : null } : {}),
        lockVersion: { increment: 1 },
      },
    });
    await tx.application.update({
      where: { id: current.applicationId },
      data: { nextActivityAt: await computeNextActivity(current.applicationId, tx) },
    });
    await audit(tx, {
      actor,
      actionCode: AuditAction.TASK_UPDATE,
      entityType: 'CrmTask',
      entityId: task.id,
      applicationId: current.applicationId,
      before: { dueAt: current.dueAt, assigneeId: current.assigneeId, status: current.status },
      after: { dueAt: task.dueAt, assigneeId: task.assigneeId, status: task.status },
      correlationId,
    });
    if (input.assigneeId && input.assigneeId !== current.assigneeId) {
      await notify(tx, {
        userId: input.assigneeId,
        code: NotifyCode.TASK_ASSIGNED,
        title: 'Задача передана вам',
        body: task.subject,
        entityType: 'CrmTask',
        entityId: task.id,
        dedupKey: `task-assigned:${task.id}:${input.assigneeId}:${task.lockVersion}`,
      });
    }
    return task;
  });
}

export async function completeTask(input: { id: string; result?: string; correlationId: string; actor: Principal }) {
  const { actor, correlationId } = input;
  const current = await prisma.crmTask.findUnique({ where: { id: input.id } });
  if (!current) throw notFound('Задача');
  if (current.status !== 'OPEN') {
    throw badRequest(ErrorCode.RESOURCE_LOCKED, 'Задача уже закрыта');
  }
  // RBAC-05: завершение чужой задачи — отдельное полномочие
  if (current.assigneeId !== actor.id) {
    assertPermission(actor.role as never, P.TASK_COMPLETE_OTHER, 'Завершить задачу другого сотрудника может только администратор.');
  }

  return prisma.$transaction(async (tx) => {
    const task = await tx.crmTask.update({
      where: { id: current.id },
      data: {
        status: 'DONE',
        completedAt: new Date(),
        completedById: actor.id,
        result: input.result ?? null,
        lockVersion: { increment: 1 },
      },
    });
    await tx.application.update({
      where: { id: current.applicationId },
      data: { nextActivityAt: await computeNextActivity(current.applicationId, tx) },
    });
    await audit(tx, {
      actor,
      actionCode: current.assigneeId === actor.id ? AuditAction.TASK_COMPLETE : AuditAction.TASK_COMPLETED_BY_OTHER,
      entityType: 'CrmTask',
      entityId: task.id,
      applicationId: current.applicationId,
      before: { status: 'OPEN' },
      after: { status: 'DONE', assigneeId: current.assigneeId, completedById: actor.id },
      correlationId,
    });
    return task;
  });
}

export async function cancelTask(input: { id: string; reason: string; correlationId: string; actor: Principal }) {
  const { actor, correlationId } = input;
  if (!input.reason?.trim()) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Укажите причину отмены задачи', {
      fields: [{ field: 'reason', message: 'Обязательное поле' }],
    });
  }
  const current = await prisma.crmTask.findUnique({ where: { id: input.id } });
  if (!current) throw notFound('Задача');
  if (current.status !== 'OPEN') throw badRequest(ErrorCode.RESOURCE_LOCKED, 'Задача уже закрыта');
  const canAny = permissionsFor(actor.role as never).includes(P.TASK_UPDATE_ANY);
  if (!canAny && current.assigneeId !== actor.id) throw forbidden('Отменить задачу может её исполнитель или администратор');

  return prisma.$transaction(async (tx) => {
    const task = await tx.crmTask.update({
      where: { id: current.id },
      data: { status: 'CANCELLED', cancelReason: input.reason.trim(), lockVersion: { increment: 1 } },
    });
    await tx.application.update({
      where: { id: current.applicationId },
      data: { nextActivityAt: await computeNextActivity(current.applicationId, tx) },
    });
    await audit(tx, {
      actor,
      actionCode: AuditAction.TASK_CANCEL,
      entityType: 'CrmTask',
      entityId: task.id,
      applicationId: current.applicationId,
      before: { status: 'OPEN' },
      after: { status: 'CANCELLED', reason: input.reason.trim() },
      correlationId,
    });
    return task;
  });
}

// ─────────────────────────── Активности (бизнес-хронология)

export async function listActivities(number: string, query: Record<string, unknown>, p: Principal) {
  const canReadAny = permissionsFor(p.role as never).includes(P.APPLICATION_READ_ANY);
  const app = await prisma.application.findUnique({ where: { number }, select: { id: true, number: true, ownerId: true } });
  if (!app) throw notFound('Заявка');
  await assertCanReadApplicationInScope(app, p, canReadAny);

  const page = parsePage(query);
  const where: Record<string, unknown> = { applicationId: app.id };
  const types = csv(query, 'type');
  if (types.length) where.type = { in: types };
  const from = dateParam(query, 'from');
  const to = dateParam(query, 'to');
  if (from || to) {
    where.occurredAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  const [total, rows] = await Promise.all([
    prisma.crmActivity.count({ where }),
    prisma.crmActivity.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      skip: page.offset,
      take: page.size,
      include: { author: { select: { id: true, fullName: true, role: true } } },
    }),
  ]);
  return { items: rows, total, page: page.page, size: page.size };
}

export interface RegisterActivityInput {
  applicationNumber: string;
  type: string;
  direction?: 'IN' | 'OUT' | null;
  participants?: string[];
  occurredAt?: string;
  subject?: string;
  content?: string;
  result?: string;
  /** Содержательная коммуникация с клиентом обновляет дату контакта. */
  isCustomerFacing?: boolean;
  correlationId: string;
  actor: Principal;
}

export async function registerActivity(input: RegisterActivityInput) {
  const { actor, correlationId } = input;
  if (!(ACTIVITY_TYPES as readonly string[]).includes(input.type)) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Неизвестный тип активности', {
      fields: [{ field: 'type', message: 'Выберите значение из справочника' }],
    });
  }
  const app = await prisma.application.findUnique({ where: { number: input.applicationNumber }, select: { id: true, number: true, ownerId: true } });
  if (!app) throw notFound('Заявка');
  await assertCanReadApplicationInScope(
    app,
    actor,
    permissionsFor(actor.role as never).includes(P.APPLICATION_READ_ANY),
  );

  const isCustomerFacing = input.isCustomerFacing ?? ['CALL', 'EMAIL', 'MEETING'].includes(input.type);
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();

  return prisma.$transaction(async (tx) => {
    const activity = await tx.crmActivity.create({
      data: {
        applicationId: app.id,
        type: input.type,
        direction: input.direction ?? null,
        participants: JSON.stringify(input.participants ?? []),
        occurredAt,
        authorId: actor.id,
        subject: input.subject ?? null,
        content: input.content ?? null,
        result: input.result ?? null,
        isCustomerFacing,
      },
    });

    // §10.1: бизнес-событие освежает last_activity_at; клиентский контакт —
    // ещё и last_customer_contact_at. Технические события не трогают коммерческую активность.
    await tx.application.update({
      where: { id: app.id },
      data: {
        lastActivityAt: new Date(),
        ...(isCustomerFacing ? { lastCustomerContactAt: occurredAt } : {}),
      },
    });

    await audit(tx, {
      actor,
      actionCode: AuditAction.ACTIVITY_REGISTER,
      entityType: 'CrmActivity',
      entityId: activity.id,
      applicationId: app.id,
      after: { type: activity.type, occurredAt, isCustomerFacing, result: activity.result },
      correlationId,
    });

    return activity;
  });
}

export async function correctActivity(input: {
  id: string;
  content: string;
  result?: string | null;
  correlationId: string;
  actor: Principal;
}) {
  const { actor, correlationId } = input;
  const current = await prisma.crmActivity.findUnique({ where: { id: input.id } });
  if (!current) throw notFound('Активность');
  // §10.1: корректировать запись можно автору или сотруднику с правом
  // редактирования чужих коммуникаций; чужие записи остаются неизменными.
  const canCorrectAny = permissionsFor(actor.role as never).includes(P.ACTIVITY_CORRECT_ANY);
  if (!canCorrectAny && current.authorId !== actor.id) {
    throw forbidden('Скорректировать коммуникацию может её автор или администратор');
  }
  if (!canCorrectAny) await assertTaskApplicationVisible(current.applicationId, actor);

  return prisma.$transaction(async (tx) => {
    const row = await tx.crmActivity.update({
      where: { id: current.id },
      data: {
        content: input.content,
        ...(input.result !== undefined ? { result: input.result } : {}),
        // §10.1: предыдущее значение сохраняется, автор правки фиксируется
        previousContent: current.content,
        correctedById: actor.id,
      },
    });
    await audit(tx, {
      actor,
      actionCode: AuditAction.ACTIVITY_CORRECT,
      entityType: 'CrmActivity',
      entityId: row.id,
      applicationId: current.applicationId,
      before: { content: current.content, result: current.result },
      after: { content: row.content, result: row.result },
      correlationId,
    });
    return row;
  });
}

// ─────────────────────────── Мои задачи (мобильный сценарий, §3.3)

export async function getMyWork(p: Principal) {
  const today = startOfDay();
  const tomorrow = new Date(today.getTime() + 86400_000);
  const scopeWhere = applyScope({ NOT: { stage: { in: ['ARCHIVED', 'CANCELLED'] } } }, p);

  const [todayTasks, overdueTasks, activeApplications, pendingApprovals] = await Promise.all([
    prisma.crmTask.findMany({
      where: { assigneeId: p.id, status: 'OPEN', dueAt: { gte: today, lt: tomorrow } },
      orderBy: { dueAt: 'asc' },
      include: { application: { select: { number: true, organization: { select: { name: true } } } } },
      take: 50,
    }),
    prisma.crmTask.findMany({
      where: { assigneeId: p.id, status: 'OPEN', dueAt: { lt: today } },
      orderBy: { dueAt: 'asc' },
      include: { application: { select: { number: true, organization: { select: { name: true } } } } },
      take: 50,
    }),
    prisma.application.findMany({
      where: scopeWhere,
      orderBy: [{ nextActivityAt: 'asc' }, { updatedAt: 'desc' }],
      take: 50,
      select: {
        id: true,
        number: true,
        stage: true,
        priority: true,
        nextActivityAt: true,
        amount: true,
        currency: true,
        organization: { select: { name: true } },
      },
    }),
    prisma.crmQuote.count({
      where: { approvalStatus: 'PENDING', application: scopeWhere },
    }),
  ]);

  return { todayTasks, overdueTasks, activeApplications, pendingApprovals };
}

export function parseNumberRange(query: Record<string, unknown>): { dueFrom?: Date; dueTo?: Date; days?: number } {
  return { dueFrom: dateParam(query, 'dueFrom'), dueTo: dateParam(query, 'dueTo'), days: numParam(query, 'days') };
}