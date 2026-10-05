import { prisma } from './prisma.js';

/**
 * Гарантии целостности, которые Prisma не может выразить в схеме.
 * Выполняются идемпотентно при старте сервера (GATE-01, CLOSE-02).
 */
export async function ensureIntegrityGuards(): Promise<void> {
  // Не более одного активного выпуска в производство на заявку.
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_production_release_active ON "ProductionRelease" ("applicationId") WHERE "state" = \'ACTIVE\'',
  );
  // Активное коммерческое основание (КП) — только одно на заявку.
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_quote_active_basis ON "CrmQuote" ("applicationId") WHERE "isActiveBasis" = 1',
  );
  // Активное коммерческое согласие на выпуск — только одно на условия.
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_release_approval_active ON "ReleaseApproval" ("commercialId") WHERE "isActive" = 1',
  );
  // Уникальность отгрузок по extSystem/extId уже объявлена в схеме Prisma.
}