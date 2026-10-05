import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError, ErrorCode, toAppError } from './errors.js';
import { config } from './config.js';
import authPlugin, { principalOf } from './plugins/auth.js';
import { registerRoutes } from './routes/index.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // OPS-05: в логах нет паролей, токенов и полного содержимого документов
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-uniprom-api-key"]',
        'req.headers["x-user-id"]',
        'body.password',
        'body.newPassword',
        'res.headers["set-cookie"]',
      ],
      transport:
        config.logLevel === 'debug' || config.logLevel === 'trace'
          ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
          : undefined,
    },
    trustProxy: true,
    bodyLimit: config.maxUploadBytes,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      cb(null, config.corsOrigins.includes(origin));
    },
    credentials: true,
  });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 10 } });
  // SEC-01: ограничение частоты. Для входа действует отдельный жёсткий лимит
  // (routes/auth.ts), общий лимит защищает API от перегрузки.
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    allowList: (req) => req.url === '/api/v1/health',
  });

  await app.register(authPlugin);

  app.setErrorHandler((err, req, reply) => {
    const appErr = toAppError(err instanceof ZodError ? mapZod(err) : err);
    if (appErr.statusCode >= 500) {
      // Технические детали только в журнале; в ответе наружу не выдаются (UI-03, OPS-05)
      req.log.error({ err, code: appErr.code, correlationId: req.correlationId }, 'Необработанная ошибка');
    } else {
      req.log.warn({ code: appErr.code, statusCode: appErr.statusCode, correlationId: req.correlationId }, appErr.message);
    }
    reply.status(appErr.statusCode).send(appErr.toPayload(req.correlationId));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      code: ErrorCode.NOT_FOUND,
      message: `Маршрут ${req.method} ${req.url} не найден`,
      correlationId: req.correlationId,
    });
  });

  app.get('/api/v1/health', async () => ({
    status: 'ok',
    service: 'uniprom-crm-api',
    env: config.env,
    time: new Date().toISOString(),
  }));

  await registerRoutes(app);

  return app;
}

function mapZod(err: ZodError): AppError {
  return new AppError(422, ErrorCode.VALIDATION_ERROR, 'Проверьте правильность заполнения полей', {
    fields: err.issues.map((i) => ({ field: i.path.join('.') || '_root', message: i.message })),
  });
}

export { principalOf };
