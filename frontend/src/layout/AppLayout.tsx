import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { ROLE_LABELS, useAuth } from '../auth/AuthContext';
import { http } from '../api/client';
import type { Notification } from '../api/types';
import { formatDateTime, useAsync } from '../components/ui';
import { BrandMark } from '../components/BrandMark';
import { BRAND } from '../brand';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  show: boolean;
}

export function AppLayout() {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();

  const notifications = useAsync((signal) => http.get<{ items: Notification[]; unread: number }>('/crm/notifications?size=8', signal), []);
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!bellOpen) return;
    const onClick = (event: MouseEvent) => {
      if (!bellRef.current?.contains(event.target as Node)) setBellOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [bellOpen]);

  const openNotification = async (item: Notification) => {
    setBellOpen(false);
    try {
      await http.post(`/crm/notifications/${item.id}/read`);
    } catch {
      // Отметка о прочтении не должна блокировать переход к заявке.
    }
    notifications.reload();
    navigate(item.entityType === 'Application' ? `/applications/${item.entityId}` : '/applications');
  };

  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: 'Работа',
      items: [
        { to: '/', label: 'Мой рабочий стол', icon: '◈', show: true },
        { to: '/applications', label: 'Заявки', icon: '☰', show: true },
        { to: '/tasks', label: 'Задачи', icon: '✓', show: true },
        { to: '/analytics', label: 'Аналитика', icon: '◔', show: can('analytics:read') },
      ],
    },
    {
      title: 'Процессы',
      items: [
        { to: '/engineering', label: 'Инженерные задания', icon: '⚙', show: can('eng:queue:read') || can('eng:work') },
        { to: '/mail', label: 'Входящая почта', icon: '✉', show: can('mail:inbox:read') },
        { to: '/imports', label: 'Импорт заявок', icon: '⇪', show: can('import:run') },
      ],
    },
    {
      title: 'Контроль',
      items: [
        { to: '/admin/users', label: 'Пользователи', icon: '⚇', show: can('admin:users') },
        { to: '/admin/references', label: 'Справочники', icon: '≡', show: can('admin:reference') },
        { to: '/admin/sla', label: 'Нормативы сроков', icon: '⏱', show: can('sla:write') },
        { to: '/admin/integrations', label: 'Интеграции 1С', icon: '⇄', show: can('admin:integrations') },
        { to: '/admin/audit', label: 'Аудит', icon: '🕓', show: can('admin:audit') || can('application:audit:read') },
      ],
    },
  ];

  const unread = notifications.data?.unread ?? 0;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <BrandMark size={30} />
          <div>
            <div className="sidebar__title">{BRAND.product}</div>
            <div className="subtle">Производство металлоконструкций</div>
          </div>
        </div>

        <nav className="sidebar__nav">
          {groups.map((group) => {
            const items = group.items.filter((i) => i.show);
            if (items.length === 0) return null;
            return (
              <div key={group.title}>
                <div className="sidebar__group">{group.title}</div>
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) => `navlink${isActive ? ' navlink--active' : ''}`}
                  >
                    <span className="navlink__icon">{item.icon}</span>
                    {item.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="sidebar__user">
          <div className="kv" style={{ gridTemplateColumns: '1fr' }}>
            <div style={{ fontWeight: 700 }}>{user?.fullName}</div>
            <div className="subtle">{ROLE_LABELS[user?.role ?? ''] ?? user?.role}</div>
          </div>
          <button className="btn btn--ghost btn--sm" onClick={() => void logout().then(() => navigate('/login'))}>
            Выйти
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="topbar__title">{BRAND.product}</span>
          <div className="topbar__spacer" />
          {can('notification:read') && (
            <div className="bell" ref={bellRef}>
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setBellOpen((open) => !open);
                  if (!bellOpen) void notifications.reload();
                }}
                aria-expanded={bellOpen}
              >
                Уведомления
                {unread > 0 && <span className="badge badge--danger">{unread}</span>}
              </button>
              {bellOpen && (
                <div className="bell__panel">
                  {notifications.loading ? (
                    <div className="subtle">Загружаю…</div>
                  ) : (notifications.data?.items.length ?? 0) === 0 ? (
                    <div className="subtle">Уведомлений нет</div>
                  ) : (
                    notifications.data!.items.map((item) => (
                      <button
                        key={item.id}
                        className={`bell__item${item.isRead ? '' : ' bell__item--unread'}`}
                        onClick={() => void openNotification(item)}
                      >
                        <span className="bell__title">{item.title}</span>
                        <span className="subtle">{formatDateTime(item.createdAt)}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}