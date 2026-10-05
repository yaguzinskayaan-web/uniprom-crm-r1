import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Button, ErrorMessage, Field } from '../components/ui';
import { BrandMark } from '../components/BrandMark';
import { BRAND } from '../brand';

/**
 * SEC-01: форма входа не различает «нет такого пользователя» и «неверный пароль» —
 * сообщение об ошибке одно и то же (это обеспечивает backend).
 */
export function LoginPage() {
  const { user, login } = useAuth();
  const location = useLocation();
  const [loginValue, setLoginValue] = useState('sales1');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (user) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(loginValue, password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <BrandMark size={30} variant="lockup" />
        <div className="login__brand">
          <h1>{BRAND.product}</h1>
          <div className="subtle">Вход в систему управления заявками</div>
        </div>

        {error ? <ErrorMessage error={error} /> : null}

        <Field label="Логин">
          <input
            value={loginValue}
            onChange={(e) => setLoginValue(e.target.value)}
            autoComplete="username"
            required
            autoFocus
          />
        </Field>

        <Field label="Пароль">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>

        <Button type="submit" busy={busy} className="btn--block">
          Войти
        </Button>

        <div className="login__hint">
          Демонстрационные учётные записи: <code>sales1</code>, <code>rm.sales</code>, <code>admin</code>, <code>ko1</code>,{' '}
          <code>rm.ko</code>, <code>proizv</code>, <code>viewer</code> — пароль <code>Uniprom#2026</code>.
        </div>
      </form>
    </div>
  );
}