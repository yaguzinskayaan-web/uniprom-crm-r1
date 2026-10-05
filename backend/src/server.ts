import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { buildServer } from './app.js';
import { prisma, tuneSqliteForConcurrency } from './lib/prisma.js';
import { ensureIntegrityGuards } from './lib/integrity.js';
import { startWorkers, stopWorkers } from './workers/index.js';

async function main() {
  const app = await buildServer();
  // A42: WAL и ожидание блокировки включаются до приёма запросов
  await tuneSqliteForConcurrency();
  await ensureIntegrityGuards();
  await app.listen({ port: config.port, host: config.host });

  app.log.info(
    { storage: config.storageDir, tz: config.defaultTimezone, devHeaders: config.allowDevHeaders },
    'UNIPROM CRM R1 API запущен',
  );

  startWorkers(app.log);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Завершение работы');
    stopWorkers();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Не удалось запустить API:', err);
  process.exit(1);
});
