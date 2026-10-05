import { prisma } from '../lib/prisma.js';
import { AppError, ErrorCode, badRequest, forbidden, notFound, conflict } from '../errors.js';
import { audit, AuditAction } from '../lib/audit.js';
import { hashPassword } from '../lib/auth.js';
import { P, assertPermission, permissionsFor } from '../domain/rbac.js';
import { assertCanReadApplicationInScope, type Principal } from '../domain/scope.js';
import { ROLES } from '../domain/constants.js';
import { loadFileForDownload, storeFile } from '../lib/storage.js';
import { parsePage } from '../lib/query.js';

/**
 * Администрирование: пользователи, справочники, рабочий календарь, файлы и
 * технический аудит (§3.1, §3.2, §14.2). Скачивание файла проверяет область
 * видимости по связанной заявке — знание идентификатора файла не даёт доступа
 * (API-01).
 */

export async function listUsers(query: Record<string, unknown>, p: Principal) {
  assertPermission(p.role as never, P.ADMIN_USERS);
  const page = parsePage(query);
  const where: Record<string, unknown> = {};
  if (query.role) where.role = String(query.role);
  if (query.active === 'true') where.isActive = true;
  if (query.active === 'false') where.isActive = false;
  if (typeof query.search === 'string' && query.search.trim()) {
    const s = query.search.trim();
    where.OR = [{ login: { contains: s } }, { fullName: { contains: s } }, { email: { contains: s } }];
  }
  const [total, items] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: [{ role: 'asc' }, { fullName: 'asc' }, { id: 'asc' }],
      skip: page.offset,
      take: page.size,
      select: {
        id: true,
        login: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        blockedAt: true,
        lockedUntil: true,
        lastLoginAt: true,
        createdAt: true,
        lockVersion: true,
      },
    }),
  ]);
  return { items, total, page: page.page, size: page.size };
}

export interface CreateUserInput {
  login: string;
  email?: string;
  fullName: string;
  role: string;
  password: string;
  correlationId: string;
  actor: Principal;
}

export async function createUser(input: CreateUserInput) {
  assertPermission(input.actor.role as never, P.ADMIN_USERS, 'Создание пользователя доступно только администратору.');
  if (!(ROLES as readonly string[]).includes(input.role)) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Выберите значение из справочника', {
      fields: [{ field: 'role', message: 'Неизвестная роль' }],
    });
  }
  assertPasswordPolicy(input.password);
  const existing = await prisma.user.findFirst({
    where: { OR: [{ login: input.login }, ...(input.email ? [{ email: input.email }] : [])] },
    select: { login: true },
  });
  if (existing) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Логин или email уже используются', {
      fields: [{ field: 'login', message: 'Занято' }],
    });
  }

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        login: input.login,
        email: input.email ?? null,
        fullName: input.fullName,
        role: input.role,
        passwordHash: hashPassword(input.password),
      },
      select: { id: true, login: true, fullName: true, role: true, isActive: true },
    });
    await audit(tx, {
      actor: input.actor,
      actionCode: AuditAction.USER_CREATE,
      entityType: 'User',
      entityId: user.id,
      after: { login: user.login, role: user.role, isActive: user.isActive },
      correlationId: input.correlationId,
    });
    return user;
  });
}

export async function updateUser(input: {
  id: string;
  lockVersion: number;
  fullName?: string;
  email?: string | null;
  role?: string;
  correlationId: string;
  actor: Principal;
}) {
  assertPermission(input.actor.role as never, P.ADMIN_USERS, 'Изменение пользователя доступно только администратору.');
  const current = await prisma.user.findUnique({ where: { id: input.id } });
  if (!current) throw notFound('Пользователь');
  if (current.lockVersion !== input.lockVersion) {
    throw conflict(ErrorCode.VERSION_CONFLICT, 'Пользователь изменён другим администратором. Обновите и повторите.', {
      details: { currentVersion: current.lockVersion },
    });
  }
  if (input.role && !(ROLES as readonly string[]).includes(input.role)) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Неизвестная роль', {
      fields: [{ field: 'role', message: 'Выберите значение из справочника' }],
    });
  }
  if (current.id === input.actor.id && input.role && input.role !== current.role) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Нельзя изменить собственную роль');
  }

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: current.id },
      data: {
        ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        lockVersion: { increment: 1 },
      },
      select: { id: true, login: true, fullName: true, email: true, role: true, isActive: true, lockVersion: true },
    });
    await audit(tx, {
      actor: input.actor,
      actionCode: AuditAction.USER_UPDATE,
      entityType: 'User',
      entityId: user.id,
      before: { fullName: current.fullName, email: current.email, role: current.role },
      after: { fullName: user.fullName, email: user.email, role: user.role },
      correlationId: input.correlationId,
    });
    return user;
  });
}

/** Блокировка отключает вход и запрещает назначение новых задач (RBAC-06). */
export async function setUserBlocked(input: { id: string; blocked: boolean; reason: string; correlationId: string; actor: Principal }) {
  assertPermission(input.actor.role as never, P.ADMIN_USERS, 'Блокировка пользователя доступна только администратору.');
  if (!input.reason?.trim()) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Укажите причину блокировки', {
      fields: [{ field: 'reason', message: 'Обязательное поле' }],
    });
  }
  const current = await prisma.user.findUnique({ where: { id: input.id } });
  if (!current) throw notFound('Пользователь');
  if (current.id === input.actor.id && input.blocked) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Нельзя заблокировать собственную учётную запись');
  }

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: current.id },
      data: {
        blockedAt: input.blocked ? new Date() : null,
        isActive: input.blocked ? false : true,
        lockedUntil: null,
        failedLogins: 0,
        lockVersion: { increment: 1 },
      },
      select: { id: true, login: true, isActive: true, blockedAt: true, lockVersion: true },
    });
    await audit(tx, {
      actor: input.actor,
      actionCode: input.blocked ? AuditAction.USER_BLOCK : AuditAction.USER_UNBLOCK,
      entityType: 'User',
      entityId: user.id,
      before: { isActive: current.isActive, blockedAt: current.blockedAt },
      after: { isActive: user.isActive, blockedAt: user.blockedAt, reason: input.reason.trim() },
      correlationId: input.correlationId,
      userReason: input.reason.trim(),
    });
    return user;
  });
}

export async function resetUserPassword(input: { id: string; newPassword: string; correlationId: string; actor: Principal }) {
  assertPermission(input.actor.role as never, P.ADMIN_USERS, 'Сброс пароля доступен только администратору.');
  assertPasswordPolicy(input.newPassword);
  const current = await prisma.user.findUnique({ where: { id: input.id } });
  if (!current) throw notFound('Пользователь');
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: current.id },
      data: { passwordHash: hashPassword(input.newPassword), lockVersion: { increment: 1 } },
      select: { id: true, login: true, lockVersion: true },
    });
    await audit(tx, {
      actor: input.actor,
      actionCode: AuditAction.PASSWORD_RESET,
      entityType: 'User',
      entityId: user.id,
      after: { login: user.login, passwordReset: true },
      correlationId: input.correlationId,
    });
    return { id: user.id, login: user.login, passwordUpdated: true };
  });
}

function assertPasswordPolicy(password: string): void {
  const issues: string[] = [];
  if (password.length < 8) issues.push('минимум 8 символов');
  if (!/[A-Za-zА-Яа-я]/.test(password)) issues.push('буквы');
  if (!/\d/.test(password)) issues.push('цифры');
  if (issues.length) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, `Пароль не соответствует требованиям: ${issues.join(', ')}`, {
      fields: [{ field: 'password', message: 'Недостаточная сложность' }],
    });
  }
}

// ─────────────────────────── Справочники и календарь

export async function listReferences(query: Record<string, unknown>, p: Principal) {
  assertPermission(p.role as never, P.REFERENCE_READ);
  const where: Record<string, unknown> = {};
  if (query.kind) where.kind = String(query.kind);
  if (query.active !== 'false') where.isActive = true;
  return prisma.referenceItem.findMany({ where, orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }] });
}

export async function upsertReference(input: {
  kind: string;
  code: string;
  label: string;
  isActive?: boolean;
  sortOrder?: number;
  correlationId: string;
  actor: Principal;
}) {
  assertPermission(input.actor.role as never, P.ADMIN_REFERENCE, 'Изменение справочников доступно только администратору.');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.referenceItem.findUnique({ where: { kind_code: { kind: input.kind, code: input.code } } });
    const row = existing
      ? await tx.referenceItem.update({
          where: { id: existing.id },
          data: {
            label: input.label,
            isActive: input.isActive ?? existing.isActive,
            sortOrder: input.sortOrder ?? existing.sortOrder,
          },
        })
      : await tx.referenceItem.create({
          data: {
            kind: input.kind,
            code: input.code,
            label: input.label,
            isActive: input.isActive ?? true,
            sortOrder: input.sortOrder ?? 0,
          },
        });
    await audit(tx, {
      actor: input.actor,
      actionCode: AuditAction.REFERENCE_UPDATE,
      entityType: 'ReferenceItem',
      entityId: row.id,
      before: existing ? { label: existing.label, isActive: existing.isActive } : null,
      after: { label: row.label, isActive: row.isActive },
      correlationId: input.correlationId,
    });
    return row;
  });
}

export async function listCalendars(p: Principal) {
  assertPermission(p.role as never, P.REFERENCE_READ);
  return prisma.workCalendar.findMany({ orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
}

export async function upsertCalendar(input: {
  id?: string;
  name: string;
  timezone: string;
  weekdays: number[];
  workStart: string;
  workEnd: string;
  holidays: string[];
  isDefault: boolean;
  correlationId: string;
  actor: Principal;
}) {
  assertPermission(input.actor.role as never, P.ADMIN_CALENDAR, 'Изменение календаря доступно только администратору.');
  if (!/^\d{2}:\d{2}$/.test(input.workStart) || !/^\d{2}:\d{2}$/.test(input.workEnd)) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Время начала и окончания в формате ЧЧ:ММ', {
      fields: [{ field: 'workStart', message: 'Формат ЧЧ:ММ' }],
    });
  }
  if (input.workStart >= input.workEnd) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Начало рабочего дня должно быть раньше окончания', {
      fields: [{ field: 'workEnd', message: 'Проверьте интервал' }],
    });
  }

  return prisma.$transaction(async (tx) => {
    const data = {
      name: input.name,
      timezone: input.timezone,
      weekdays: JSON.stringify([...new Set(input.weekdays)].sort()),
      workStart: input.workStart,
      workEnd: input.workEnd,
      holidays: JSON.stringify([...new Set(input.holidays)].sort()),
      isDefault: input.isDefault,
    };
    if (input.isDefault) {
      // календарь по умолчанию всегда один
      await tx.workCalendar.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }
    const row = input.id
      ? await tx.workCalendar.update({ where: { id: input.id }, data })
      : await tx.workCalendar.create({ data });
    await audit(tx, {
      actor: input.actor,
      actionCode: AuditAction.CALENDAR_UPDATE,
      entityType: 'WorkCalendar',
      entityId: row.id,
      after: { name: row.name, weekdays: row.weekdays, workStart: row.workStart, workEnd: row.workEnd, isDefault: row.isDefault },
      correlationId: input.correlationId,
    });
    return row;
  });
}

// ─────────────────────────── Файлы

export async function uploadFile(input: {
  buffer: Buffer;
  originalName: string;
  contentType: string;
  applicationNumber?: string;
  correlationId: string;
  actor: Principal;
}) {
  const canReadAny = permissionsFor(input.actor.role as never).includes(P.APPLICATION_READ_ANY);
  let applicationId: string | null = null;
  if (input.applicationNumber) {
    const app = await prisma.application.findUnique({ where: { number: input.applicationNumber }, select: { id: true, number: true, ownerId: true } });
    if (!app) throw notFound('Заявка');
    await assertCanReadApplicationInScope(app, input.actor, canReadAny);
    applicationId = app.id;
  }
  const file = await storeFile({
    buffer: input.buffer,
    originalName: input.originalName,
    contentType: input.contentType,
    uploadedById: input.actor.id,
  });
  if (applicationId) {
    await prisma.applicationFile.create({ data: { fileId: file.id, applicationId } });
  }
  await audit(prisma, {
    actor: input.actor,
    actionCode: 'FILE_UPLOAD',
    entityType: 'StoredFile',
    entityId: file.id,
    applicationId,
    payload: { originalName: file.originalName, sizeBytes: file.sizeBytes },
    correlationId: input.correlationId,
  });
  return file;
}

/** Скачивание ограничено областью видимости связанной заявки (API-01, A01). */
export async function downloadFile(fileId: string, p: Principal) {
  const links = await prisma.applicationFile.findMany({
    where: { fileId },
    select: { application: { select: { id: true, number: true, ownerId: true } } },
  });
  const canReadAny = permissionsFor(p.role as never).includes(P.APPLICATION_READ_ANY);
  if (links.length > 0) {
    // Область видимости проверяется той же выборкой, что и список заявок (RBAC-01)
    const checks = await Promise.all(
      links.map((l) =>
        assertCanReadApplicationInScope(l.application, p, canReadAny).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (!checks.some(Boolean)) throw forbidden('Файл связан с заявкой, доступ к которой закрыт');
  }
  const { file, buffer } = await loadFileForDownload(fileId);
  if (!file.uploadedById && !canReadAny) {
    throw forbidden('Недостаточно прав для скачивания файла');
  }
  return { file, buffer };
}

export async function listFiles(query: Record<string, unknown>, p: Principal) {
  const page = parsePage(query);
  const canReadAny = permissionsFor(p.role as never).includes(P.APPLICATION_READ_ANY);
  const rows = await prisma.storedFile.findMany({
    where: query.applicationNumber
      ? { links: { some: { application: { number: String(query.applicationNumber) } } } }
      : undefined,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    skip: page.offset,
    take: page.size,
    include: { links: { select: { application: { select: { id: true, number: true, ownerId: true } } } } },
  });
  // Проверка области видимости асинхронна: решение принимает та же выборка,
  // что и список заявок, поэтому синхронный filter здесь неприменим
  const visibility = await Promise.all(
    rows.map(async (f) => {
      if (f.links.length === 0) return canReadAny || f.uploadedById === p.id;
      const checks = await Promise.all(
        f.links.map((l) =>
          assertCanReadApplicationInScope(l.application, p, canReadAny).then(
            () => true,
            () => false,
          ),
        ),
      );
      return checks.some(Boolean);
    }),
  );
  const visible = rows.filter((_, i) => visibility[i]);
  return { items: visible, page: page.page, size: page.size, total: visible.length };
}

// ─────────────────────────── Технический аудит (§14.2)

export async function listAuditEvents(query: Record<string, unknown>, p: Principal) {
  assertPermission(p.role as never, P.ADMIN_AUDIT, 'Просмотр технического аудита доступен только администратору.');
  const page = parsePage(query);
  const where: Record<string, unknown> = {};
  if (query.actionCode) where.actionCode = String(query.actionCode);
  if (query.entityType) where.entityType = String(query.entityType);
  if (query.actorId) where.actorUserId = String(query.actorId);
  if (query.correlationId) where.correlationId = String(query.correlationId);
  if (query.applicationNumber) {
    const app = await prisma.application.findUnique({ where: { number: String(query.applicationNumber) }, select: { id: true } });
    where.applicationId = app?.id ?? '__none__';
  }
  if (query.userReason === 'required') where.userReason = { not: null };
  const from = typeof query.from === 'string' ? new Date(query.from) : undefined;
  const to = typeof query.to === 'string' ? new Date(query.to) : undefined;
  if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };

  const [total, items] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: page.offset,
      take: page.size,
    }),
  ]);
  return { items, total, page: page.page, size: page.size };
}

/** Справочник пользователей для выпадающих списков (исполнители, согласующие). */
export async function listAssignableUsers(p: Principal) {
  assertPermission(p.role as never, P.REFERENCE_READ);
  const users = await prisma.user.findMany({
    where: { isActive: true, blockedAt: null },
    orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
    select: { id: true, fullName: true, login: true, role: true },
  });
  return users;
}

export function assertNotSelf(targetId: string, actorId: string, what: string): void {
  if (targetId === actorId) {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, `${what}: недопустимо для собственной учётной записи`);
  }
}
