import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.js';
import { applicationRoutes } from './applications.js';
import { quoteRoutes } from './quotes.js';
import { engineeringRoutes } from './engineering.js';
import { opsRoutes } from './ops.js';
import { commercialRoutes } from './commercial.js';
import { taskRoutes } from './tasks.js';
import { analyticsRoutes } from './analytics.js';
import { mailRoutes } from './mail.js';
import { importRoutes } from './imports.js';
import { adminRoutes } from './admin.js';
import { integrationRoutes } from './integrations.js';
import { crmContractRoutes } from './crmContract.js';

/**
 * Маршруты собираются по модулям домена. Каждая группа содержит собственные
 * проверки прав и области видимости: скрытие элементов интерфейса не является
 * способом ограничения доступа (RBAC-01).
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(authRoutes);
  await app.register(applicationRoutes);
  await app.register(quoteRoutes);
  await app.register(engineeringRoutes);
  await app.register(opsRoutes);
  await app.register(commercialRoutes);
  await app.register(taskRoutes);
  await app.register(analyticsRoutes);
  await app.register(mailRoutes);
  await app.register(importRoutes);
  await app.register(adminRoutes);
  await app.register(integrationRoutes);
  // Контрактные пути §13.3 (`/api/v1/crm/...`) поверх тех же сервисов
  await app.register(crmContractRoutes);
}
