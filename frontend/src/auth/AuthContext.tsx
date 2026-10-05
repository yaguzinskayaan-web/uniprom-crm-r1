import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { http, onSessionExpired, setToken, getToken } from '../api/client';
import type { LoginResponse, SessionUser } from '../api/types';

interface AuthValue {
  user: SessionUser | null;
  ready: boolean;
  login: (login: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Полномочия текущей роли для отображения действий (RBAC-01: скрытие кнопок не заменяет контроль на backend). */
  can: (permission: Permission) => boolean;
}

/**
 * Строки полномочий повторяют `backend/src/domain/rbac.ts` (P).
 * Сервер остаётся источником истины: скрытие кнопок — только UX (RBAC-01).
 */
export type Permission =
  | 'reference:read'
  | 'application:list'
  | 'application:read:any'
  | 'application:create'
  | 'application:update'
  | 'application:update:any'
  | 'application:assign'
  | 'application:complexity:set'
  | 'application:complexity:downgrade'
  | 'application:stage:change'
  | 'application:cancel:loss'
  | 'application:archive'
  | 'application:delete'
  | 'application:timeline:read'
  | 'application:audit:read'
  | 'org:read'
  | 'org:write'
  | 'contact:read'
  | 'task:read:any'
  | 'task:create'
  | 'task:update:any'
  | 'task:complete:other'
  | 'activity:correct:any'
  | 'quote:read'
  | 'quote:create'
  | 'quote:update:draft'
  | 'quote:upload'
  | 'quote:submit-approval'
  | 'quote:approve'
  | 'quote:send'
  | 'quote:record-external-send'
  | 'quote:accept'
  | 'quote:supersede'
  | 'eng:queue:read'
  | 'eng:task:create'
  | 'eng:assign'
  | 'eng:work'
  | 'eng:conclusion:approve'
  | 'eng:cancel'
  | 'commercial:read'
  | 'commercial:write'
  | 'contract:sign'
  | 'release:check'
  | 'release:execute'
  | 'release:approve:manual'
  | 'release:override'
  | 'fulfillment:read'
  | 'fulfillment:write'
  | 'production:stages:update'
  | 'close:check'
  | 'close:execute'
  | 'mail:inbox:read'
  | 'mail:inbox:process'
  | 'import:run'
  | 'import:commit'
  | 'sla:read'
  | 'sla:write'
  | 'notification:read'
  | 'analytics:read'
  | 'analytics:export'
  | 'admin:users'
  | 'admin:reference'
  | 'admin:integrations'
  | 'admin:audit'
  | 'admin:calendar'
  | 'file:download';

const SALES_BASE: Permission[] = [
  'reference:read',
  'application:list',
  'application:create',
  'application:update',
  'application:complexity:set',
  'application:stage:change',
  'application:timeline:read',
  'org:read',
  'org:write',
  'contact:read',
  'task:read:any',
  'task:create',
  'quote:read',
  'quote:create',
  'quote:update:draft',
  'quote:upload',
  'quote:submit-approval',
  'quote:send',
  'quote:record-external-send',
  'quote:accept',
  'eng:task:create',
  'commercial:read',
  'release:check',
  'fulfillment:read',
  'fulfillment:write',
  'close:check',
  'close:execute',
  'mail:inbox:read',
  'mail:inbox:process',
  'import:run',
  'import:commit',
  'sla:read',
  'notification:read',
  'analytics:read',
  'analytics:export',
  'file:download',
];

const SALES_MANAGER: Permission[] = [
  ...SALES_BASE,
  'application:read:any',
  'application:update:any',
  'application:assign',
  'application:archive',
  'quote:approve',
  'eng:queue:read',
  'eng:conclusion:approve',
  'application:complexity:downgrade',
  'commercial:write',
  'contract:sign',
  'release:execute',
  'release:approve:manual',
];

const DESIGN_MANAGER: Permission[] = [
  'reference:read',
  'application:list',
  'application:read:any',
  'application:timeline:read',
  'org:read',
  'contact:read',
  'eng:queue:read',
  'eng:task:create',
  'eng:assign',
  'eng:conclusion:approve',
  'eng:cancel',
  'application:complexity:downgrade',
  'quote:read',
  'commercial:read',
  'fulfillment:read',
  'sla:read',
  'notification:read',
  'file:download',
];

const DESIGNER: Permission[] = [
  'reference:read',
  'application:list',
  'application:timeline:read',
  'org:read',
  'contact:read',
  'eng:work',
  'quote:read',
  'fulfillment:read',
  'notification:read',
  'file:download',
];

const PRODUCTION: Permission[] = [
  'reference:read',
  'application:list',
  'application:timeline:read',
  'org:read',
  'production:stages:update',
  'commercial:read',
  'fulfillment:read',
  'fulfillment:write',
  'release:check',
  'close:check',
  'sla:read',
  'notification:read',
  'file:download',
];

const VIEWER: Permission[] = [
  'reference:read',
  'application:list',
  'application:timeline:read',
  'org:read',
  'contact:read',
  'quote:read',
  'commercial:read',
  'fulfillment:read',
  'sla:read',
  'analytics:read',
  'notification:read',
  'file:download',
];

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  SALES: SALES_BASE,
  SALES_MANAGER: SALES_MANAGER,
  DESIGN_MANAGER: DESIGN_MANAGER,
  DESIGNER: DESIGNER,
  PRODUCTION: PRODUCTION,
  VIEWER: VIEWER,
  ADMIN: [
    ...SALES_MANAGER,
    'application:delete',
    'application:audit:read',
    'task:update:any',
    'task:complete:other',
    'activity:correct:any',
    'production:stages:update',
    'release:override',
    'sla:write',
    'admin:users',
    'admin:reference',
    'admin:integrations',
    'admin:audit',
    'admin:calendar',
  ],
};

export const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  SALES_MANAGER: 'Руководитель продаж',
  SALES: 'Менеджер по продажам',
  DESIGN_MANAGER: 'Руководитель КО',
  DESIGNER: 'Конструктор',
  PRODUCTION: 'Производство',
  VIEWER: 'Наблюдатель',
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);

  const loadProfile = useCallback(async () => {
    try {
      const profile = await http.get<SessionUser>('/auth/me');
      setUser(profile);
    } catch {
      setUser(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    if (getToken()) void loadProfile();
    else setReady(true);
  }, [loadProfile]);

  // Сессия истекла по 401 — возвращаем экран входа без перезагрузки страницы.
  useEffect(() => onSessionExpired(() => setUser(null)), []);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      ready,
      login: async (loginValue: string, password: string) => {
        const result = await http.post<LoginResponse>('/auth/login', { login: loginValue, password });
        setToken(result.token);
        setUser(result.user);
      },
      logout: async () => {
        try {
          await http.post('/auth/logout');
        } finally {
          setToken(null);
          setUser(null);
        }
      },
      can: (permission: Permission) => (user ? (ROLE_PERMISSIONS[user.role] ?? []).includes(permission) : false),
    }),
    [user, ready],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth требует AuthProvider');
  return ctx;
}