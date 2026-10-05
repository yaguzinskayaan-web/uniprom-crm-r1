import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { prisma } from '../lib/prisma.js';
import { assertNoDevHeaders, claimsToPrincipal, verifyToken } from '../lib/auth.js';
import { AppError, ErrorCode } from '../errors.js';
import { ROLE_SCOPE } from '../domain/rbac.js';
import type { Principal } from '../domain/scope.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    correlationId: string;
  }
  interface FastifyInstance {
    /** Требует действительной сессии. Роль и область берутся из проверенного токена. */
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async (app: FastifyInstance) => {
  app.decorateRequest('principal', undefined);
  app.decorateRequest('correlationId', '');

  app.addHook('onRequest', async (req) => {
    req.correlationId =
      (req.headers['x-correlation-id'] as string | undefined) ?? (req.id as string) ?? 'unknown';
    assertNoDevHeaders(req.headers as Record<string, unknown>);
  });

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Требуется вход в систему');
    }
    const claims = verifyToken(header.slice(7));
    // SEC-02: пользователь и роли определяются backend из проверенной сессии.
    // Блокировка пользователя прекращает доступ, включая доступ к документам.
    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, login: true, fullName: true, role: true, isActive: true, blockedAt: true },
    });
    if (!user) throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Учётная запись не найдена');
    if (!user.isActive || user.blockedAt) {
      throw new AppError(403, ErrorCode.USER_BLOCKED, 'Учётная запись заблокирована. Обратитесь к администратору.');
    }
    const expectedScope = ROLE_SCOPE[user.role as keyof typeof ROLE_SCOPE] ?? 'NONE';
    // Роль всегда перечитывается из БД: изменение роли действует немедленно.
    const principal: Principal = {
      id: user.id,
      login: user.login,
      role: user.role,
      fullName: user.fullName,
      scope: expectedScope,
    };
    req.principal = principal;
  });
});

export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) {
    throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Требуется вход в систему');
  }
  return req.principal;
}
