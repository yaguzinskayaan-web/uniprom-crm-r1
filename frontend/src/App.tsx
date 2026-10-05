import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { AppLayout } from './layout/AppLayout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { ApplicationsPage } from './pages/ApplicationsPage';
import { NewApplicationPage } from './pages/NewApplicationPage';
import { ApplicationCardPage } from './pages/ApplicationCardPage';
import { TasksPage } from './pages/TasksPage';
import { EngineeringPage } from './pages/EngineeringPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { MailPage } from './pages/MailPage';
import { ImportsPage } from './pages/ImportsPage';
import { AdminAuditPage } from './pages/admin/AdminAuditPage';
import { AdminIntegrationsPage } from './pages/admin/AdminIntegrationsPage';
import { AdminReferencesPage } from './pages/admin/AdminReferencesPage';
import { AdminSlaPage } from './pages/admin/AdminSlaPage';
import { AdminUsersPage } from './pages/admin/AdminUsersPage';
import './styles.css';

function ProtectedRoute() {
  const { user, ready } = useAuth();
  const location = useLocation();

  if (!ready) {
    return (
      <div className="login">
        <div className="spinner spinner--dark" />
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <Outlet />;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'applications', element: <ApplicationsPage /> },
          { path: 'applications/new', element: <NewApplicationPage /> },
          { path: 'applications/:number', element: <ApplicationCardPage /> },
          { path: 'tasks', element: <TasksPage /> },
          { path: 'engineering', element: <EngineeringPage /> },
          { path: 'analytics', element: <AnalyticsPage /> },
          { path: 'mail', element: <MailPage /> },
          { path: 'imports', element: <ImportsPage /> },
          { path: 'admin/users', element: <AdminUsersPage /> },
          { path: 'admin/references', element: <AdminReferencesPage /> },
          { path: 'admin/sla', element: <AdminSlaPage /> },
          { path: 'admin/integrations', element: <AdminIntegrationsPage /> },
          { path: 'admin/audit', element: <AdminAuditPage /> },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]);

export default function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}