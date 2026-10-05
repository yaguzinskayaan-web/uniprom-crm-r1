import { Prisma, PrismaClient } from '@prisma/client';
import { config } from '../config.js';

export const prisma = new PrismaClient({
  log: config.logLevel === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  datasources: { db: { url: config.databaseUrl } },
  transactionOptions: {
    // Запись под блокировкой SQLite может занять время: при 30 одновременных
    // пользователях отказ по таймауту (P1008) недопустим
    maxWait: 60_000,
    timeout: 60_000,
  },
});

/**
 * A42: параметры режима SQLite, влияющие на конкурентную работу.
 *
 * WAL позволяет читать во время записи, а busy_timeout превращает ожидание
 * блокировки в паузу вместо ошибки SQLITE_BUSY. Оба значения действуют на
 * соединение, поэтому выставляются один раз при старте.
 */
export async function tuneSqliteForConcurrency(): Promise<void> {
  // PRAGMA возвращает текущее значение, поэтому выполняется через queryRaw:
  // $executeRaw в SQLite отвергает запросы, возвращающие результат
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 60000;');
  await prisma.$queryRawUnsafe('PRAGMA synchronous = NORMAL;');
}

export { Prisma };
export type { PrismaClient };
export type TxClient = Prisma.TransactionClient;