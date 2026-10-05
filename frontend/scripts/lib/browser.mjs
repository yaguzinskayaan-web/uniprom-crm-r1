/**
 * Общий слой браузерных проверок: запуск Chrome, разговор по Chrome DevTools
 * Protocol, ожидание отрисовки и работа с формами React.
 *
 * Вынесено отдельно, потому что используется двумя скриптами: `ui-check.mjs`
 * читает экраны, `ui-flows.mjs` проходит сценарии с изменением данных.
 *
 * Зависимостей нет: CDP держится на встроенном в Node `WebSocket` и `fetch`.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Шум в консоли, который не является дефектом продукта. */
export const NOISE = /favicon|DevTools|Download the React|React Router Future Flag|React Router will begin|reactrouter\.com/i;

const CHROME_CANDIDATES = [
  process.env.UI_CHECK_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findChrome() {
  return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** Падение с внятным текстом, если нужный сервер не поднят. */
export async function requireServer(url, hint) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    throw new Error(`Сервер ${url} недоступен (${e.message}). ${hint}`);
  }
}

/** Клиент CDP поверх WebSocket: отправляет команды и раздаёт события подписчикам. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const waiter = msg.id ? this.pending.get(msg.id) : undefined;
      if (waiter) {
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
        else waiter.resolve(msg.result);
        return;
      }
      if (msg.method) for (const l of this.listeners) l(msg);
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`таймаут ${method}`));
        }
      }, 30000);
    });
  }

  on(listener) {
    this.listeners.push(listener);
  }

  /** Значение выражения в странице; исключение внутри считаем дефектом проверки. */
  async eval(expression, sessionId) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`${d.text} ${d.exception?.description ?? ''}`.slice(0, 300));
    }
    return r.result.value;
  }
}

/**
 * Сводка по отрисованной странице: объём контента и найденные блоки ошибок.
 * Считается в браузере, чтобы не тянуть лишний текст наружу.
 */
const READ_DOM = `(() => {
  const root = document.getElementById('root') || document.body;
  const text = (root.innerText || '').trim();
  const errors = Array.from(document.querySelectorAll('[class*="error"]'))
    .map((n) => (n.innerText || '').trim())
    .filter((t) => t && t.length < 200);
  return {
    chars: text.length,
    tables: document.querySelectorAll('table').length,
    rows: document.querySelectorAll('tbody tr').length,
    errors: Array.from(new Set(errors)).slice(0, 3),
  };
})()`;

/**
 * Открытая страница. Держит список дефектов, накопленных с последней навигации:
 * необработанные исключения, ошибки консоли, неуспешные запросы и блоки ошибок.
 */
export class Page {
  constructor(cdp, sessionId, settleMs) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.settleMs = settleMs;
    this.bucket = { exceptions: [], console: [], network: [] };
  }

  eval(expression) {
    return this.cdp.eval(expression, this.sessionId);
  }

  resetBucket() {
    this.bucket = { exceptions: [], console: [], network: [] };
  }

  async goto(url) {
    this.resetBucket();
    await this.cdp.send('Page.navigate', { url }, this.sessionId);
    const ready = await this.waitForContent(this.settleMs);
    await sleep(400);
    return ready;
  }

  /** Ждём наполнения документа, а не просто паузу. */
  async waitForContent(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await this.eval(
        "(() => { const t = (document.getElementById('root') || document.body).innerText || ''; return t.trim().length > 80; })()",
      );
      if (ready) return true;
      await sleep(200);
    }
    return false;
  }

  async dom() {
    return this.eval(READ_DOM);
  }

  async text() {
    return this.eval("((document.getElementById('root') || document.body).innerText || '').trim()");
  }

  async url() {
    return this.eval('location.pathname + location.search');
  }

  /** Дефекты, накопленные с последней навигации. */
  problems(dom) {
    const problems = [];
    if (this.bucket.exceptions.length) problems.push(`необработанное исключение: ${this.bucket.exceptions[0]}`);
    if (dom && dom.errors.length) problems.push(`блок ошибки на странице: ${dom.errors.join(' | ')}`);
    const consoleErrors = this.bucket.console.filter((c) => !NOISE.test(c));
    if (consoleErrors.length) problems.push(`ошибка в консоли: ${consoleErrors[0]}`);
    const netErrors = this.bucket.network.filter((t) => !NOISE.test(t));
    if (netErrors.length) problems.push(`неуспешный запрос: ${netErrors[0]}`);
    return problems;
  }

  /**
   * Ждёт, пока выражение не станет истинным. Данные приходят асинхронно, и
   * проверка сразу после навигации была бы нестабильной: счётчик или таблица
   * успевают появиться не всегда.
   */
  async waitFor(expression, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    for (;;) {
      try {
        if (await this.eval(expression)) return true;
        lastError = null;
      } catch (e) {
        // Ошибку запоминаем, а не глотаем: иначе «выражение упало» и «условие
        // не выполнилось» выглядят одинаково и диагностика становится слепой.
        lastError = e;
      }
      if (Date.now() > deadline) break;
      await sleep(150);
    }
    if (lastError) throw lastError;
    return false;
  }

  /**
   * Выполняет ожидания и возвращает провалившиеся вместе с их общим числом,
   * чтобы вызывающий код мог честно посчитать выполненные проверки. Каждое
   * ожидание обязано стать истинным за несколько секунд, а не мгновенно.
   */
  async expect(list, timeoutMs = 4000) {
    const failed = [];
    for (const [label, expression] of list ?? []) {
      let ok = false;
      try {
        ok = await this.waitFor(expression, timeoutMs);
      } catch (e) {
        failed.push(`проверка «${label}» упала: ${e.message}`);
        continue;
      }
      if (!ok) failed.push(`не выполнено ожидание «${label}»`);
    }
    return { failed, total: list?.length ?? 0 };
  }
}

/** Свободный порт: иначе можно подключиться к чужому браузеру. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Закрывает Chrome вместе со всеми дочерними процессами. */
function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* процесс уже мёртв */
      }
      resolve();
    }
  });
}

/**
 * Запускает headless Chrome, открывает одну вкладку и поднимает слушатели
 * дефектов. Возвращает страницу и функцию корректного завершения.
 */
export async function launchBrowser({ settle = 3200, debugPort } = {}) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('CHROME_MISSING');

  // Порт выбираем свободным: занятый порт означал бы, что мы подключились к
  // браузеру прошлого запуска, у которого в localStorage лежит токен, и проверка
  // входа молча проверяла бы уже авторизованную страницу.
  const port = debugPort ?? (await freePort());
  const profile = mkdtempSync(join(tmpdir(), 'uniprom-ui-'));
  const child = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore', detached: process.platform !== 'win32' },
  );

  let version;
  for (let i = 0; i < 60 && !version; i++) {
    await sleep(400);
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      // браузер ещё запускается
    }
  }
  if (!version) {
    await killTree(child.pid);
    throw new Error('Браузер не поднялся и не открыл порт отладки.');
  }

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('не удалось подключиться к браузеру')));
  });
  const cdp = new Cdp(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const page = new Page(cdp, sessionId, settle);
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      page.bucket.exceptions.push(String(d.exception?.description || d.text).slice(0, 300));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      page.bucket.console.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const e = msg.params.entry;
      // URL обязателен: текст самой ошибки его не содержит, и без него нельзя
      // отличить безобидный favicon от настоящего сбоя загрузки данных.
      page.bucket.network.push(`${e.source}: ${e.text} ${e.url ?? ''}`.slice(0, 300));
    }
  });

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const close = async () => {
    // Сначала просим браузер закрыться самому: это надёжнее убийства процесса
    // и гарантирует, что порт отладки освободится, а профиль удалится целиком.
    try {
      await Promise.race([cdp.send('Browser.close'), sleep(2000)]);
    } catch {
      // браузер мог закрыться раньше ответа
    }
    await killTree(child.pid);
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // временный профиль может остаться — на результат не влияет
    }
  };

  return { page, close, chromePath };
}

/**
 * Ввод в контролируемый React-инпут. Прямое присваивание `element.value`
 * не вызывает onChange, поэтому используем нативный сеттер и событие.
 */
export function fillField(page, labelText, value) {
  return page.eval(`(() => {
    const label = Array.from(document.querySelectorAll('label.field')).find((x) => (x.innerText || '').includes(${JSON.stringify(labelText)}));
    if (!label) return 'нет поля «${labelText}»';
    const el = label.querySelector('input, textarea, select');
    if (!el) return 'нет элемента в поле «${labelText}»';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
}

/** Ввод в поле по placeholder: строки позиций сделаны без обёртки Field. */
export function fillPlaceholder(page, placeholder, value) {
  return page.eval(`(() => {
    const el = document.querySelector('input[placeholder=${JSON.stringify(placeholder)}]');
    if (!el) return 'нет поля с подсказкой «${placeholder}»';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
}

/** Клик по элементу, в тексте которого есть подстрока. */
export function clickByText(page, selector, text) {
  return page.eval(`(() => {
    const el = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((x) => (x.innerText || '').includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
}

/** Переключение вкладки карточки по её подписи. */
export function clickTab(page, label) {
  return clickByText(page, '.tabs .tab', label);
}

/** Текст модального окна, если оно открыто. */
export function modalText(page) {
  return page.eval("(document.querySelector('.modal') || document.querySelector('[role=dialog]') || {}).innerText || ''");
}