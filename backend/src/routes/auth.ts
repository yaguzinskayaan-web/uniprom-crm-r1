import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ctx, requireAuth } from './context.js';
import { changePassword, getProfile, login, logout } from '../services/auth.js';
import { config } from '../config.js';

const loginBody = z.object({
  login: z.string().min(1, 'Укажите логин'),
  password: z.string().min(1, 'Укажите пароль'),
});

const passwordBody = z.object({
  currentPassword: z.string().min(1, 'Укажите текущий пароль'),
  newPassword: z.string().min(8, 'Новый пароль должен содержать не менее 8 символов'),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // SEC-01: публичный вход с отдельным жёстким лимитом попыток, остальные
  // маршруты — только по действующей сессии.
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: config.authRateLimitMax, timeWindow: config.rateLimitWindowMs } } },
    async (req, reply) => {
      const body = loginBody.parse(req.body);
      const result = await login({
        login: body.login,
        password: body.password,
        correlationId: req.correlationId,
        ip: req.ip,
      });
      return reply.send(result);
    },
  );

  app.get(
    '/api/v1/auth/me',
    { preHandler: requireAuth() },
    async (req) => {
      const { principal } = ctx(req);
      return getProfile(principal.id);
    },
  );

  app.post(
    '/api/v1/auth/logout',
    { preHandler: requireAuth() },
    async (req) => {
      const { principal, correlationId } = ctx(req);
      return logout(principal.id, correlationId);
    },
  );

  app.post(
    '/api/v1/auth/password',
    { preHandler: requireAuth() },
    async (req) => {
      const { principal, correlationId } = ctx(req);
      const body = passwordBody.parse(req.body);
      return changePassword({ userId: principal.id, ...body, correlationId });
    },
  );
}
