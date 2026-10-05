import { randomUUID } from 'node:crypto';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

/**
 * SQLite сериализует писателей: при конкурентных записях соединение получает
 * SQLITE_BUSY и Prisma обрывает запрос по таймауту (P1008) — при 30
 * одновременных пользователях это 500-я ошибка вместо успешной записи.
 *
 * Пул ограничен одним соединением: без этого ограничения SQLite отвечает
 * SQLITE_BUSY на конкурентные записи. Ожидание блокировки обеспечивается
 * PRAGMA busy_timeout (см. lib/prisma.ts), а socket_timeout оставляет
 * соединению время дождаться освобождения замка.
 */
function sqliteUrl(url: string): string {
  if (!url.startsWith('file:')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}connection_limit=1&socket_timeout=60`;
}

export const config = {
  env: env('NODE_ENV', 'development'),
  port: Number(env('PORT', '3001')),
  host: env('HOST', '0.0.0.0'),
  databaseUrl: sqliteUrl(env('DATABASE_URL', 'file:./prisma/crm.db')),
  jwtSecret: env('JWT_SECRET', 'dev-only-change-me-please-32-chars-min'),
  jwtTtlSeconds: Number(env('JWT_TTL_SECONDS', String(60 * 60 * 12))),
  /** Токен интеграций (почтовый приёмник, вебхуки 1С). Переопределяется в .env. */
  integrationToken: env('INTEGRATION_TOKEN', 'dev-integration-token'),
  defaultTimezone: env('TZ_DEFAULT', 'Asia/Yekaterinburg'),
  storageDir: env('STORAGE_DIR', './var/storage'),
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  logLevel: env('LOG_LEVEL', 'info'),

  // SEC-02: DEV headers are refused outside development.
  allowDevHeaders: env('NODE_ENV', 'development') !== 'production',

  // SEC-01
  maxFailedLogins: Number(env('MAX_FAILED_LOGINS', '5')),
  lockoutMinutes: Number(env('LOCKOUT_MINUTES', '15')),

  // API-01
  defaultPageSize: 50,
  maxPageSize: 200,

  // API-02
  maxImportRows: Number(env('MAX_IMPORT_ROWS', '5000')),

  // SYNC-06: freshness window required for automatic release
  paymentDataFreshnessMinutes: Number(env('PAYMENT_DATA_FRESHNESS_MIN', '120')),

  // §13.1 storage abstraction
  maxUploadBytes: Number(env('MAX_UPLOAD_BYTES', String(25 * 1024 * 1024))),

  // SEC-01: ограничение частоты. Для входа действует отдельный жёсткий лимит,
  // общий лимит API защищает от перегрузки и не ограничивает рабочие сценарии.
  rateLimitMax: Number(env('RATE_LIMIT_MAX', '1200')),
  authRateLimitMax: Number(env('AUTH_RATE_LIMIT_MAX', '30')),
  rateLimitWindowMs: Number(env('RATE_LIMIT_WINDOW_MS', '60000')),

  // A19/A45: доставка исходящих очередей.
  // Если адрес не задан, транспорт возвращает UNKNOWN — система не показывает
  // ложный SENT и не выполняет слепую повторную отправку (SEND-03).
  mailTransportUrl: env('MAIL_TRANSPORT_URL', ''),
  outboxTargetUrl: env('OUTBOX_TARGET_URL', ''),
  /** Интервал опроса очередей фоновым воркером. */
  deliveryIntervalMs: Number(env('DELIVERY_INTERVAL_MS', '30000')),
  deliveryTimeoutMs: Number(env('DELIVERY_TIMEOUT_MS', '15000')),
  /** Интервал первой повторной попытки; далее — экспоненциально, до часа. */
  deliveryBackoffBaseMs: Number(env('DELIVERY_BACKOFF_BASE_MS', '60000')),
};

export function newCorrelationId(): string {
  return randomUUID();
}
