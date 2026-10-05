import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { AppError, ErrorCode, notFound } from '../errors.js';
import { SCOPE, type Scope } from './rbac.js';

export interface Principal {
  id: string;
  login: string;
  role: string;
  fullName: string;
  scope: Scope;
}

export type AppWhere = Prisma.ApplicationWhereInput;

/**
 * Единая политика области видимости для чтения (RBAC-01, RBAC-02).
 * Применяется одинаково к спискам, поиску, агрегатам, карточке,
 * скачиванию файлов и экспорту (API-01).
 */
export function applyScope(where: AppWhere, p: Principal): AppWhere {
  switch (p.scope) {
    case SCOPE.ALL:
      return where;

    // RBAC-02: SALES видит только назначенные ему заявки — их КП, суммы, файлы и коммуникации
    case SCOPE.OWN_APPS:
      return { ...where, ownerId: p.id };

    // DESIGN_MANAGER: направленные в КО заявки и задания (§3.1 «Очередь КО»)
    case SCOPE.KO_QUEUE:
      return {
        ...where,
        OR: [
          { engTasks: { some: { assigneeId: p.id } } },
          { engTasks: { some: { createdById: p.id } } },
          { engTasks: { some: {} } },
        ],
      };

    // DESIGNER: назначенные инженерные задания
    case SCOPE.ASSIGNED_ENG:
      return { ...where, engTasks: { some: { assigneeId: p.id } } };

    // PRODUCTION: выпущенные в производство в своей области доступа
    case SCOPE.PRODUCED:
      return {
        ...where,
        stage: {
          in: [
            'TO_PRODUCTION',
            'DESIGN_IN_PROGRESS',
            'DESIGN_COMPLETE',
            'MANUFACTURING',
            'READY_TO_SHIP',
            'FULFILLMENT',
            'CLOSED',
          ],
        },
      };

    // VIEWER: область настраивается политикой доступа; по умолчанию — ничего не видно
    case SCOPE.NONE:
      return { ...where, id: '__none__' };

    default:
      return { ...where, id: '__none__' };
  }
}

/** Может ли пользователь читать конкретную заявку (после выборки). */
export function canReadApplication(app: { ownerId: string | null; stage: string }, p: Principal): boolean {
  switch (p.scope) {
    case SCOPE.ALL:
      return true;
    case SCOPE.OWN_APPS:
      return app.ownerId === p.id;
    case SCOPE.KO_QUEUE:
    case SCOPE.ASSIGNED_ENG:
    case SCOPE.PRODUCED:
    case SCOPE.NONE:
      return false; // уточняется запросом с областью
    default:
      return false;
  }
}

export function assertCanReadApplication(
  app: { id: string; number: string; ownerId: string | null },
  p: Principal,
  canReadAny: boolean,
): void {
  if (canReadAny) return;
  if (app.ownerId === p.id) return;
  // Не раскрываем факт существования чужой заявки (§17 A01)
  throw notFound('Заявка');
}

/**
 * Проверка чтения по той же области видимости, что и список заявок.
 *
 * Синхронная проверка выше отвечает на вопрос «владелец ли я этой заявки» и
 * достаточна для ролей с областью OWN_APPS. Для остальных областей (PRODUCTION,
 * KO_QUEUE, ASSIGNED_ENG) право зависит от этапа и назначений, поэтому решение
 * принимает та же выборка, что и список, — иначе список показывал бы заявку,
 * а карточка возвращала бы 404 (RBAC-01/RBAC-02).
 */
export async function assertCanReadApplicationInScope(
  app: { id: string; number: string },
  p: Principal,
  canReadAny: boolean,
): Promise<void> {
  if (canReadAny) return;

  const visible = await prisma.application.findFirst({
    where: app.id
      ? applyScope({ id: app.id }, p)
      : applyScope({ number: app.number }, p),
    select: { id: true },
  });
  if (visible) return;

  // Факт существования чужой заявки не раскрывается (§17 A01)
  throw notFound('Заявка');
}

/** Сопоставление контрагента: минимальные реквизиты без чужой коммерческой истории (RBAC-02). */
export function orgPublicFields(includeCommercial: boolean) {
  return {
    id: true,
    name: true,
    fullName: true,
    inn: true,
    kpp: true,
    website: true,
    industry: true,
    isArchived: true,
    ...(includeCommercial ? { address: true, ownerId: true } : {}),
  } as const;
}
