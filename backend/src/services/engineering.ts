import { prisma } from '../lib/prisma.js';
import { AppError, ErrorCode, badRequest, forbidden, notFound, conflict } from '../errors.js';
import { audit, AuditAction } from '../lib/audit.js';
import { notify, NotifyCode } from '../lib/notifications.js';
import { assertAssignableDesigner } from './applications.js';
import { P, assertPermission, permissionsFor } from '../domain/rbac.js';
import { applyScope, type Principal } from '../domain/scope.js';
import { csv, jparse, parsePage, q } from '../lib/query.js';
import { ENG_DECISIONS, ENG_TASK_STATUSES, type Complexity } from '../domain/constants.js';

// ─────────────────────────── Очередь КО (§3.1, §13.3)

export async function listEngineeringTasks(query: Record<string, unknown>, p: Principal) {
  assertPermission(p.role as never, P.ENG_READ_QUEUE);
  const page = parsePage(query);
  const kinds = csv(query, 'kind');
  const statuses = csv(query, 'status');
  const unassigned = query.unassigned === 'true';
  const mine = query.mine === 'true';

  // DESIGNER видит только назначенные себе задания
  const where = {
    ...(kinds.length ? { kind: { in: kinds } } : {}),
    ...(statuses.length ? { status: { in: statuses } } : {}),
    ...(unassigned ? { assigneeId: null } : {}),
    ...(mine ? { assigneeId: p.id } : {}),
    ...(p.role === 'DESIGNER' ? { assigneeId: p.id } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.engineeringTask.findMany({
      where,
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      skip: page.offset,
      take: page.size,
      include: {
        application: {
          select: { id: true, number: true, stage: true, complexity: true, organization: { select: { name: true, inn: true } } },
        },
        assignee: { select: { id: true, fullName: true, role: true } },
        createdBy: { select: { id: true, fullName: true } },
        conclusions: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    }),
    prisma.engineeringTask.count({ where }),
  ]);
  return { items, total, page: page.page, size: page.size };
}

export async function getEngineeringTask(id: string, p: Principal) {
  const task = await prisma.engineeringTask.findUnique({
    where: { id },
    include: {
      application: { include: { lines: true, organization: true, contact: true, fileLinks: { include: { file: true } } } },
      assignee: { select: { id: true, fullName: true, role: true } },
      createdBy: { select: { id: true, fullName: true, role: true } },
      conclusions: {
        orderBy: { createdAt: 'desc' },
        include: {
          author: { select: { id: true, fullName: true, role: true } },
          approvedBy: { select: { id: true, fullName: true, role: true } },
        },
      },
    },
  });
  if (!task) throw notFound('Инженерное задание');
  if (p.role === 'DESIGNER' && task.assigneeId !== p.id) throw notFound('Инженерное задание');
  return task;
}

// ─────────────────────────── Создание (ENG-04)

export interface CreateEngTaskInput {
  number: string;
  kind: 'PREQUOTE' | 'ORDER_DESIGN';
  assigneeId?: string | null;
  priority: string;
  dueAt?: string;
  questions?: string;
  correlationId: string;
  actor: Principal;
}

export async function createEngineeringTask(input: CreateEngTaskInput) {
  const { actor, correlationId } = input;
  assertPermission(actor.role as never, P.ENG_CREATE_TASK);

  const app = await prisma.application.findUnique({
    where: { number: input.number },
    include: { lines: true, organization: true, contact: true, fileLinks: { include: { file: true } } },
  });
  if (!app) throw notFound('Заявка');

  // До договора КО получает доступ через PREQUOTE; после допуска — через ORDER_DESIGN
  if (input.kind === 'ORDER_DESIGN' && app.stage !== 'CONTRACT_SIGNED' && app.stage !== 'TO_PRODUCTION') {
    throw badRequest(
      ErrorCode.INVALID_STAGE_TRANSITION,
      'Задание на разработку документации (ORDER_DESIGN) создаётся после подписания договора. Действующий этап заявки — ' +
        app.stage,
    );
  }

  if (input.assigneeId) {
    // §3.1: назначение DESIGNER выполняют DESIGN_MANAGER или ADMIN
    const canAssign = permissionsFor(actor.role as never).includes(P.ENG_ASSIGN_DESIGNER);
    if (!canAssign) {
      throw forbidden('Назначение конструктора доступно руководителю конструкторского отдела или администратору (ТЗ §3.1).');
    }
    await assertAssignableDesigner(input.assigneeId);
  }

  // ENG-04: снимок исходных данных задания
  const inputSnapshot = jparse<Record<string, unknown>>(app.engineQuestions, {});
  const inputRevision = `rev-${app.versionNo}`;

  const task = await prisma.$transaction(async (tx) => {
    const created = await tx.engineeringTask.create({
      data: {
        applicationId: app.id,
        kind: input.kind,
        status: input.assigneeId ? 'ASSIGNED' : 'NEW',
        assigneeId: input.assigneeId ?? null,
        createdById: actor.id,
        priority: input.priority,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        questions: input.questions ?? null,
        inputSnapshot: JSON.stringify({
          engineQuestions: inputSnapshot,
          lines: app.lines.map((l) => ({ lineId: l.lineId, name: l.name, quantity: l.quantity, params: jparse(l.params, {}) })),
          attachments: app.fileLinks.map((f) => ({ id: f.file.id, name: f.file.originalName })),
          contact: app.contact ? { name: app.contact.fullName, phone: app.contact.phone, email: app.contact.email } : null,
        }),
        inputRevision,
        initiatedAt: new Date(),
        lockVersion: 1,
      },
    });

    await audit(tx, {
      actor,
      actionCode: AuditAction.ENG_TASK_CREATE,
      entityType: 'EngineeringTask',
      entityId: created.id,
      applicationId: app.id,
      after: { kind: input.kind, assigneeId: input.assigneeId ?? null, dueAt: input.dueAt ?? null },
      correlationId,
    });

    if (input.assigneeId) {
      await notify(tx, {
        userId: input.assigneeId,
        code: NotifyCode.ENG_TASK_ASSIGNED,
        title: `Новое задание КО: заявка ${app.number}`,
        body: input.kind === 'PREQUOTE' ? 'Предварительная проработка' : 'Разработка документации',
        entityType: 'EngineeringTask',
        entityId: created.id,
        dedupKey: `eng-assigned:${created.id}`,
      });
    }
    return created;
  });

  return task;
}

// ─────────────────────────── Назначение / статус

export async function assignEngineeringTask(id: string, assigneeId: string, correlationId: string, actor: Principal) {
  // §3.1: SALES_MANAGER не назначает конструкторов; A03
  if (!permissionsFor(actor.role as never).includes(P.ENG_ASSIGN_DESIGNER)) {
    throw forbidden('Назначение конструктора доступно только роли DESIGN_MANAGER или ADMIN (ТЗ §3.1, A03).');
  }
  await assertAssignableDesigner(assigneeId);

  const task = await prisma.engineeringTask.findUnique({ where: { id }, include: { application: true } });
  if (!task) throw notFound('Инженерное задание');
  if (['COMPLETED', 'CANCELLED'].includes(task.status)) {
    throw badRequest(ErrorCode.INVALID_STAGE_TRANSITION, 'Завершённое или отменённое задание нельзя переназначить');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.engineeringTask.update({
      where: { id },
      data: { assigneeId, status: task.status === 'NEW' ? 'ASSIGNED' : task.status, lockVersion: { increment: 1 } },
    });
    await audit(tx, {
      actor,
      actionCode: AuditAction.ENG_TASK_ASSIGN,
      entityType: 'EngineeringTask',
      entityId: id,
      applicationId: task.applicationId,
      before: { assigneeId: task.assigneeId },
      after: { assigneeId },
      correlationId,
    });
    await notify(tx, {
      userId: assigneeId,
      code: NotifyCode.ENG_TASK_ASSIGNED,
      title: `Задание КО назначено вам: ${task.application.number}`,
      entityType: 'EngineeringTask',
      entityId: id,
      dedupKey: `eng-assigned:${id}:${row.lockVersion}`,
    });
    return row;
  });
  return updated;
}

export async function updateEngineeringTaskStatus(
  id: string,
  status: string,
  lockVersion: number,
  correlationId: string,
  actor: Principal,
) {
  if (!(ENG_TASK_STATUSES as readonly string[]).includes(status)) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Неизвестный статус инженерного задания');
  }
  if (status === 'COMPLETED') {
    // Завершение задания выполняется через действие с заключением
    throw badRequest(
      ErrorCode.VALIDATION_ERROR,
      'Завершение задания выполняется действием «Зафиксировать заключение» — требуется результат проработки.',
      { fields: [{ field: 'status', message: 'Используйте действие complete с заключением' }] },
    );
  }
  const canWork = permissionsFor(actor.role as never).includes(P.ENG_WORK);
  const canQueue = permissionsFor(actor.role as never).includes(P.ENG_ASSIGN_DESIGNER);
  if (!canWork && !canQueue) throw forbidden('Недостаточно прав для изменения статуса инженерного задания');

  const task = await prisma.engineeringTask.findUnique({ where: { id }, include: { application: true } });
  if (!task) throw notFound('Инженерное задание');
  if (canWork && task.assigneeId !== actor.id) {
    throw forbidden('Изменять статус можно только собственного инженерного задания');
  }
  if (task.lockVersion !== lockVersion) {
    throw conflict(ErrorCode.VERSION_CONFLICT, 'Задание изменено другим пользователем. Обновите и повторите.', {
      details: { currentVersion: task.lockVersion, yourVersion: lockVersion },
    });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.engineeringTask.update({
      where: { id },
      data: {
        status,
        ...(status === 'IN_PROGRESS' && !task.startedAt ? { startedAt: new Date() } : {}),
        lockVersion: { increment: 1 },
      },
    });
    await audit(tx, {
      actor,
      actionCode: AuditAction.ENG_TASK_STATUS,
      entityType: 'EngineeringTask',
      entityId: id,
      applicationId: task.applicationId,
      before: { status: task.status },
      after: { status },
      correlationId,
    });
    if (status === 'WAITING_INPUT' && task.application.ownerId) {
      await notify(tx, {
        userId: task.application.ownerId,
        code: NotifyCode.ENG_TASK_RETURNED,
        title: `КО вернул заявку ${task.application.number} на уточнение`,
        body: 'Ожидаются исходные данные от клиента',
        entityType: 'EngineeringTask',
        entityId: id,
        dedupKey: `eng-waiting:${id}:${row.lockVersion}`,
      });
    }
    return row;
  });
  return updated;
}

export async function cancelEngineeringTask(id: string, reason: string, correlationId: string, actor: Principal) {
  assertPermission(actor.role as never, P.ENG_CANCEL);
  if (!reason) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Отмена задания требует указания причины', {
      fields: [{ field: 'reason', message: 'Обязательное поле' }],
    });
  }
  const task = await prisma.engineeringTask.findUnique({ where: { id } });
  if (!task) throw notFound('Инженерное задание');

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.engineeringTask.update({
      where: { id },
      data: { status: 'CANCELLED', lockVersion: { increment: 1 } },
    });
    // Отменённое задание не должно оставаться блокирующим для КП
    await tx.engineeringConclusion.updateMany({
      where: { engineeringTaskId: id, isValid: true },
      data: { isValid: false, invalidatedReason: `TASK_CANCELLED: ${reason}` },
    });
    await audit(tx, {
      actor,
      actionCode: AuditAction.ENG_TASK_CANCEL,
      entityType: 'EngineeringTask',
      entityId: id,
      applicationId: task.applicationId,
      after: { reason },
      correlationId,
    });
    return row;
  });
  return updated;
}

// ─────────────────────────── Заключение (ENG-05)

export interface CompleteEngTaskInput {
  id: string;
  decision: string;
  conditions?: string;
  technicalExecution?: string;
  priceInputs?: Record<string, unknown>;
  leadTimeDays?: number;
  fileIds?: string[];
  correlationId: string;
  actor: Principal;
}

export async function completeEngineeringTask(input: CompleteEngTaskInput) {
  const { actor, correlationId } = input;
  if (!permissionsFor(actor.role as never).includes(P.ENG_WORK)) {
    throw forbidden('Зафиксировать заключение может назначенный конструктор (DESIGNER)');
  }
  if (!(ENG_DECISIONS as readonly string[]).includes(input.decision)) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Неизвестное решение конструкторского отдела');
  }
  if (input.decision === 'FEASIBLE_WITH_CONDITIONS' && !input.conditions) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Для решения «Допустимо с условиями» укажите условия', {
      fields: [{ field: 'conditions', message: 'Обязательное поле' }],
    });
  }

  const task = await prisma.engineeringTask.findUnique({
    where: { id: input.id },
    include: { application: { select: { id: true, number: true, versionNo: true, ownerId: true } } },
  });
  if (!task) throw notFound('Инженерное задание');
  if (task.assigneeId !== actor.id) {
    throw forbidden('Зафиксировать заключение может только исполнитель задания');
  }

  // ENG-05: положительный результат действует только для указанной ревизии параметров
  const validForRevision = `rev-${task.application.versionNo}`;

  const result = await prisma.$transaction(async (tx) => {
    const conclusion = await tx.engineeringConclusion.create({
      data: {
        engineeringTaskId: task.id,
        applicationId: task.applicationId,
        decision: input.decision,
        conditions: input.conditions ?? null,
        technicalExecution: input.technicalExecution ?? null,
        priceInputs: input.priceInputs ? JSON.stringify(input.priceInputs) : null,
        leadTimeDays: input.leadTimeDays ?? null,
        validForRevision,
        authorId: actor.id,
        isValid: input.decision !== 'NOT_FEASIBLE',
      },
    });

    if (input.fileIds?.length) {
      for (const fileId of input.fileIds) {
        await tx.applicationFile.create({
          data: { applicationId: task.applicationId, fileId, purpose: 'ENG_REVISION', refId: conclusion.id },
        });
      }
    }

    const updatedTask = await tx.engineeringTask.update({
      where: { id: task.id },
      data: { status: 'COMPLETED', completedAt: new Date(), lockVersion: { increment: 1 } },
    });

    await audit(tx, {
      actor,
      actionCode: AuditAction.ENG_CONCLUSION_CREATE,
      entityType: 'EngineeringConclusion',
      entityId: conclusion.id,
      applicationId: task.applicationId,
      after: { decision: input.decision, validForRevision, conditions: input.conditions ?? null },
      correlationId,
    });

    const approvers = await tx.user.findMany({ where: { role: 'DESIGN_MANAGER', isActive: true }, select: { id: true } });
    for (const a of approvers) {
      await notify(tx, {
        userId: a.id,
        code: NotifyCode.ENG_CONCLUSION_SUBMITTED,
        title: `Заключение по заявке ${task.application.number} ожидает утверждения`,
        body: input.decision,
        entityType: 'EngineeringConclusion',
        entityId: conclusion.id,
        dedupKey: `eng-approve:${conclusion.id}:${a.id}`,
      });
    }
    return { conclusion, task: updatedTask };
  });

  return result;
}

export async function approveEngineeringConclusion(
  id: string,
  approve: boolean,
  comment: string | undefined,
  correlationId: string,
  actor: Principal,
) {
  assertPermission(actor.role as never, P.ENG_APPROVE_CONCLUSION);
  const conclusion = await prisma.engineeringConclusion.findUnique({
    where: { id },
    include: { engineeringTask: true },
  });
  if (!conclusion) throw notFound('Заключение');
  const app = await prisma.application.findUnique({
    where: { id: conclusion.applicationId },
    select: { number: true, versionNo: true, ownerId: true },
  });
  if (conclusion.authorId === actor.id && actor.role !== 'ADMIN') {
    throw forbidden('Утверждать собственное заключение нельзя');
  }
  if (conclusion.approvedAt) {
    throw conflict(ErrorCode.VERSION_CONFLICT, 'Заключение уже утверждено');
  }

  const result = await prisma.$transaction(async (tx) => {
    const row = await tx.engineeringConclusion.update({
      where: { id },
      data: {
        approvedById: actor.id,
        approvedAt: new Date(),
        ...(approve ? {} : { isValid: false, invalidatedReason: comment ?? 'REJECTED_BY_DESIGN_MANAGER' }),
      },
    });
    await audit(tx, {
      actor,
      actionCode: AuditAction.ENG_CONCLUSION_APPROVE,
      entityType: 'EngineeringConclusion',
      entityId: id,
      applicationId: conclusion.applicationId,
      after: { approve, comment: comment ?? null },
      correlationId,
    });
    if (app?.ownerId) {
      await notify(tx, {
        userId: app.ownerId,
        code: approve ? NotifyCode.ENG_CONCLUSION_SUBMITTED : NotifyCode.ENG_CONCLUSION_NEEDS_DATA,
        title: approve
          ? `Заключение по заявке ${app.number} утверждено`
          : `Заключение по заявке ${app.number} отклонено`,
        body: comment ?? null,
        entityType: 'EngineeringConclusion',
        entityId: id,
        dedupKey: `eng-decision:${id}:${approve ? 'ok' : 'no'}`,
      });
    }
    return row;
  });
  return result;
}

// ─────────────────────────── Проверка заключения для бизнес-правил

export interface ConclusionCheck {
  hasApprovedPositive: boolean;
  revisionMatches: boolean;
  hasPendingUnapproved: boolean;
  conclusionId: string | null;
  conditions: string | null;
}

/**
 * A11: признак обязательного участия КО вычисляется сервером из параметров позиций
 * (`requiresKo`), а не приходит от frontend. Поэтому правило нельзя обойти
 * изменением клиента: подмена значения в запросе не влияет на проверку.
 */
export async function isKoMandatory(applicationId: string): Promise<boolean> {
  const lines = await prisma.applicationLine.findMany({
    where: { applicationId },
    select: { params: true },
  });
  return lines.some((l) => {
    if (!l.params) return false;
    try {
      const parsed = JSON.parse(l.params) as { requiresKo?: unknown };
      return parsed?.requiresKo === true;
    } catch {
      return false;
    }
  });
}

/**
 * ENG-06: окончательное КП по CUSTOM и по MODIFIED с обязательным КО нельзя
 * коммерчески согласовать и отправить без действующего положительного заключения.
 * A12: при изменении параметров после заключения требуется повторная проверка.
 */
export async function checkConclusion(
  applicationId: string,
  complexity: Complexity,
  koMandatory: boolean,
): Promise<ConclusionCheck> {
  const conclusions = await prisma.engineeringConclusion.findMany({
    where: { applicationId },
    orderBy: { createdAt: 'desc' },
  });
  const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { versionNo: true } });
  const currentRevision = `rev-${app?.versionNo ?? 1}`;

  const positive = conclusions.find(
    (c) =>
      c.isValid &&
      c.approvedAt !== null &&
      (c.decision === 'FEASIBLE' || c.decision === 'FEASIBLE_WITH_CONDITIONS'),
  );

  const requires = complexity === 'CUSTOM' || (complexity === 'MODIFIED' && koMandatory);
  if (!requires) {
    return {
      hasApprovedPositive: Boolean(positive),
      revisionMatches: positive ? positive.validForRevision === currentRevision : true,
      hasPendingUnapproved: false,
      conclusionId: positive?.id ?? null,
      conditions: positive?.conditions ?? null,
    };
  }

  return {
    hasApprovedPositive: Boolean(positive),
    revisionMatches: positive ? positive.validForRevision === currentRevision : false,
    hasPendingUnapproved: conclusions.some((c) => !c.approvedAt && c.decision !== 'NOT_FEASIBLE'),
    conclusionId: positive?.id ?? null,
    conditions: positive?.conditions ?? null,
  };
}

export function assertConclusionAllowsQuote(check: ConclusionCheck, complexity: Complexity, koMandatory: boolean): void {
  const requires = complexity === 'CUSTOM' || (complexity === 'MODIFIED' && koMandatory);
  if (!requires) return;
  if (!check.hasApprovedPositive) {
    throw new AppError(
      422,
      ErrorCode.TECH_CONCLUSION_NOT_APPROVED,
      complexity === 'CUSTOM'
        ? 'Нестандартное изделие: требуется действующее положительное заключение конструкторского отдела, утверждённое руководителем КО.'
        : 'Модифицированное исполение с обязательным участием КО: требуется действующее положительное заключение конструкторского отдела.',
    );
  }
  if (!check.revisionMatches) {
    throw new AppError(
      409,
      ErrorCode.TECH_REVISION_CHANGED,
      'Исходные параметры изменились после заключения КО. Заключение действует только для своей ревизии — требуется повторная проработка (ТЗ ENG-05, A12).',
    );
  }
}

export type { AppError };
