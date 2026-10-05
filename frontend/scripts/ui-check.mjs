/**
 * Проверка живой отрисовки CRM в настоящем браузере.
 *
 * Зачем: smoke-тесты проверяют HTTP-контракты и возвращают 200 даже тогда, когда
 * страница падает на отрисовке. Именно так были найдены все контрактные дефекты
 * интерфейса: тип объявлял поля, которых нет в ответе (`totals`, `avgDays`,
 * `data.items` у массива), и React падал на `undefined.map`. Этот скрипт
 * открывает каждый маршрут в headless Chrome и падает, если на странице есть
 * необработанное исключение, блок ошибки, неуспешный запрос API или не
 * выполнено ожидаемое содержимое. Дополнительно обходятся все вкладки карточки.
 *
 * Сценарии с изменением данных живут отдельно, в `ui-flows.mjs`.
 *
 * Зависимостей нет: Chrome DevTools Protocol через встроенный в Node
 * WebSocket и fetch. Устанавливать Playwright или Puppeteer не нужно.
 *
 * Использование (frontend и backend должны быть уже запущены):
 *   cd backend && npm run dev          # backend на 3001
 *   cd frontend && npm run dev         # фронтенд на 5174
 *   cd frontend && npm run ui:check    # проверка всех маршрутов и вкладок
 *   node scripts/ui-check.mjs --strict   # отсутствие Chrome — ошибка, а не пропуск
 *
 * Переменные окружения:
 *   SMOKE_BASE         адрес backend (по умолчанию http://127.0.0.1:3001)
 *   SMOKE_PASSWORD     пароль администратора (по умолчанию Uniprom#2026)
 *   UI_CHECK_LOGIN     логин (по умолчанию admin)
 *   UI_CHECK_APP_URL   адрес фронтенда (по умолчанию http://127.0.0.1:5174)
 *   UI_CHECK_CHROME    путь к Chrome или Edge, если он не в стандартном месте
 *   UI_CHECK_DEBUG_PORT порт отладки; по умолчанию выбирается свободный, иначе
 *                      можно подключиться к браузеру прошлого запуска
 *   UI_CHECK_SETTLE    сколько ждать наполнения страницы, мс (по умолчанию 3200)
 *
 * Скрипт ничего не меняет в данных: он только читает API, чтобы получить токен,
 * и выбирает заявку для обхода карточки.
 */

import { launchBrowser, requireServer, clickTab, sleep } from './lib/browser.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const APP = value('app', process.env.UI_CHECK_APP_URL ?? 'http://127.0.0.1:5174');
const ORIGIN = value('api', process.env.SMOKE_BASE ?? 'http://127.0.0.1:3001');
const API = `${ORIGIN}/api/v1`;
const LOGIN = value('login', process.env.UI_CHECK_LOGIN ?? 'admin');
const PASSWORD = value('password', process.env.SMOKE_PASSWORD ?? 'Uniprom#2026');
const DEBUG_PORT = value('debug-port', process.env.UI_CHECK_DEBUG_PORT ?? '');
const SETTLE = Number(value('settle', process.env.UI_CHECK_SETTLE ?? '3200'));
const TAB_SETTLE = Number(value('tab-settle', process.env.UI_CHECK_TAB_SETTLE ?? '1800'));
const STRICT = flag('strict');

const ROUTES = [
  {
    route: '/',
    label: 'рабочий стол',
    expect: [
      [
        'счётчик активных заявок больше нуля',
        "(() => { const m = /Активные заявки\\s*(\\d[\\d\\s]*)/.exec(document.body.innerText); return !!m && Number(m[1].replace(/\\s/g, '')) > 0; })()",
      ],
      ['приходят номера счетов в ожидаемых поступлениях', '/INV-/.test(document.body.innerText)'],
    ],
  },
  { route: '/applications', label: 'список заявок', expect: [['таблица заявок не пуста', 'document.querySelectorAll("tbody tr").length > 0']] },
  { route: '/tasks', label: 'задачи', expect: [['раздел задач отрисован', 'document.body.innerText.includes("Задачи")']] },
  { route: '/engineering', label: 'инженерные задания', expect: [['таблица заданий не пуста', 'document.querySelectorAll("tbody tr").length > 0']] },
  {
    route: '/analytics',
    label: 'аналитика',
    expect: [
      [
        'заявок в периоде больше нуля',
        "(() => { const m = /Заявок в периоде\\s*(\\d[\\d\\s]*)/.exec(document.body.innerText); return !!m && Number(m[1].replace(/\\s/g, '')) > 0; })()",
      ],
      [
        'сроки этапов отрисованы, без NaN и undefined',
        `(() => {
          const card = Array.from(document.querySelectorAll('.card')).find((c) => (c.querySelector('h2')?.innerText || '').includes('Среднее время на этапах'));
          if (!card) return false;
          const t = card.innerText;
          if (/NaN|undefined|Infinity/.test(t)) return false;
          return /выборок:/.test(t);
        })()`,
      ],
      [
        'полосы сроков имеют корректную ширину 0..100%',
        `(() => {
          const card = Array.from(document.querySelectorAll('.card')).find((c) => (c.querySelector('h2')?.innerText || '').includes('Среднее время на этапах'));
          if (!card) return false;
          const bars = Array.from(card.querySelectorAll('.progress__bar'));
          return bars.length > 0 && bars.every((b) => { const w = parseFloat(b.style.width); return Number.isFinite(w) && w >= 0 && w <= 100; });
        })()`,
      ],
      ['показаны открытые КП по валютам', '/Открытые КП\\s*·\\s*[A-Z]{3}/.test(document.body.innerText)'],
      [
        'показаны конверсии в договор и в выигрыш',
        "document.body.innerText.includes('Конверсия в договор') && document.body.innerText.includes('Конверсия в выигрыш')",
      ],
    ],
  },
  { route: '/mail', label: 'почта', expect: [['таблица писем не пуста', 'document.querySelectorAll("tbody tr").length > 0']] },
  { route: '/imports', label: 'импорты', expect: [['таблица импортов не пуста', 'document.querySelectorAll("tbody tr").length > 0']] },
  {
    route: '/applications/new',
    label: 'новая заявка',
    expect: [
      ['форма отрисованa', 'document.body.innerText.includes("Новая заявка")'],
      [
        'есть поля организации, позиций и кнопка создания',
        'document.querySelectorAll("form input").length >= 4 && Array.from(document.querySelectorAll("button")).some((b) => (b.innerText || "").includes("Создать заявку"))',
      ],
      ['показан ключ идемпотентности', '/ui-\\d+-[a-z0-9]+/.test(document.body.innerText)'],
    ],
  },
  { route: '/admin/users', label: 'админ: пользователи', expect: [['таблица пользователей не пуста', 'document.querySelectorAll("tbody tr").length > 0']] },
  { route: '/admin/references', label: 'админ: справочники', expect: [['таблица справочников не пуста', 'document.querySelectorAll("tbody tr").length > 0']] },
  { route: '/admin/sla', label: 'админ: SLA', expect: [['таблицы нормативов не пусты', 'document.querySelectorAll("tbody tr").length > 0']] },
  { route: '/admin/integrations', label: 'админ: интеграции', expect: [['очередь интеграций не пуста', 'document.querySelectorAll("tbody tr").length > 0']] },
  { route: '/admin/audit', label: 'админ: аудит', expect: [['таблица аудита не пуста', 'document.querySelectorAll("tbody tr").length > 0']] },
];

/**
 * Ожидания по вкладкам карточки. Вкладка «Исполнение и закрытие» проверяется
 * отдельно и содержательно: именно там было больше всего дефектов контракта, и
 * часть из них не падала, а молча показывала пустоту.
 */
const TAB_EXPECT = {
  Позиции: [['таблица позиций не пуста', 'document.querySelectorAll("tbody tr").length > 0']],
  Производство: [['таблица производства не пуста', 'document.querySelectorAll("tbody tr").length > 0']],
  'Исполнение и закрытие': [
    ['есть блок готовности к закрытию', 'document.body.innerText.includes("Готовность к закрытию")'],
    [
      'закрывающие документы посчитаны',
      '/Комплект:/.test(document.body.innerText) && !/Комплект:\\s*0\\s*из\\s*0/.test(document.body.innerText)',
    ],
    ['заказы и остаток отгрузки показаны числами', '/ОСТАТОК/.test(document.body.innerText)'],
  ],
};

let failures = 0;
let checks = 0;

/** Считает выполненные проверки и добавляет провалы к списку проблем. */
async function collect(page, problems, list) {
  const { failed, total } = await page.expect(list);
  checks += total;
  problems.push(...failed);
}

function report(name, dom, problems) {
  if (problems.length) failures++;
  const mark = problems.length ? 'FAIL' : ' ok ';
  console.log(`${mark} ${name} — таблиц ${dom.tables}, строк ${dom.rows}, символов ${dom.chars}`);
  for (const p of problems) console.log(`       -> ${p}`);
}

async function main() {
  await requireServer(`${ORIGIN}/api/v1/health`, 'Запустите backend: cd backend && npm run dev');
  await requireServer(APP, 'Запустите фронтенд: cd frontend && npm run dev');

  const auth = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
  });
  if (!auth.ok) throw new Error(`Не удалось войти ${LOGIN}: HTTP ${auth.status}. Проверьте SMOKE_PASSWORD.`);
  const { token } = await auth.json();

  const listRes = await fetch(`${API}/applications?size=100`, { headers: { authorization: `Bearer ${token}` } });
  const items = listRes.ok ? (await listRes.json()).items ?? [] : [];
  if (!items.length) throw new Error('Нет ни одной заявки: карточку проверить не на чем.');
  // Берём заявку, у которой есть закрывающие документы: на ней наполнены самые
  // тяжёлые блоки вкладки исполнения, и пустая вкладка не маскирует регрессию.
  // Заявок много, а закрывающие документы есть у единиц, поэтому опрашиваем всю
  // страницу списка: она ограничена сервером, лишних запросов не получается.
  let applicationNumber = items[0].number;
  for (const app of items) {
    const f = await fetch(`${API}/applications/${app.number}/fulfilment`, { headers: { authorization: `Bearer ${token}` } });
    if (!f.ok) continue;
    if (((await f.json()).closingDocuments ?? []).length > 0) {
      applicationNumber = app.number;
      break;
    }
  }

  let browser;
  try {
    browser = await launchBrowser({ settle: SETTLE, debugPort: DEBUG_PORT ? Number(DEBUG_PORT) : undefined });
  } catch (e) {
    if (e.message === 'CHROME_MISSING') {
      console.log(
        'ПРОПУЩЕНО. Chrome или Edge не найден. Укажите путь в UI_CHECK_CHROME или запустите со --strict.',
      );
      process.exit(STRICT ? 1 : 0);
    }
    throw e;
  }
  const { page, close, chromePath } = browser;
  console.log(`Проверка отрисовки: ${APP} (браузер ${chromePath})`);

  // Форма входа проверяется до подстановки токена: с токеном она редиректит
  // на рабочий стол, и проверять её было бы нечем.
  await page.goto(`${APP}/login`);
  {
    const dom = await page.dom();
    const problems = page.problems(dom);
    await collect(page, problems, [
      ['нарисована форма входа', 'document.querySelector(".login__card") !== null'],
      [
        'есть поля логина и пароля',
        'document.querySelectorAll(\'input[type="password"]\').length === 1 && document.querySelectorAll(\'label.field input\').length >= 2',
      ],
      ['логотип отрисован', 'document.querySelector(".login__card svg, .login__card img, .login__brand") !== null'],
      ['есть кнопка входа', 'Array.from(document.querySelectorAll("button")).some((b) => /Войти|Вход/i.test(b.innerText || ""))'],
    ]);
    report('/login (вход, без токена)', dom, problems);
  }

  // Токен кладём напрямую: так проверка не зависит от вёрстки формы входа и
  // остаётся проверкой отрисовки защищённых экранов, а не сценария логина.
  await page.eval(`localStorage.setItem('uniprom.token', ${JSON.stringify(token)}); true`);

  for (const { route, label, expect = [] } of ROUTES) {
    try {
      await page.goto(`${APP}${route}`);
      const dom = await page.dom();
      const problems = page.problems(dom);
      await collect(page, problems, expect);
      report(`${route} (${label})`, dom, problems);
    } catch (e) {
      failures++;
      console.log(`FAIL ${route} (${label}) — проверка не выполнена: ${e.message}`);
    }
  }

  // Карточка заявки: самые тяжёлые дефекты контракта были именно в её вкладках.
  const cardUrl = `${APP}/applications/${applicationNumber}`;
  try {
    await page.goto(cardUrl);
    const dom = await page.dom();
    const problems = page.problems(dom);
    await collect(page, problems, [
      ['открылся номер заявки', `document.body.innerText.includes(${JSON.stringify(applicationNumber)})`],
    ]);
    report(`карточка ${applicationNumber}`, dom, problems);
  } catch (e) {
    failures++;
    console.log(`FAIL карточка ${applicationNumber} — ${e.message}`);
  }

  try {
    page.resetBucket();
    await page.goto(cardUrl);
    const labels = await page.eval(
      "Array.from(document.querySelectorAll('.tabs .tab')).map((b) => (b.innerText || '').trim())",
    );
    if (!labels.length) {
      failures++;
      console.log('FAIL вкладки карточки — вкладки не найдены, карточка не отрисовалась');
    }
    for (const label of labels) {
      page.resetBucket();
      await clickTab(page, label);
      await sleep(TAB_SETTLE);
      const dom = await page.dom();
      const problems = page.problems(dom);
      await collect(page, problems, TAB_EXPECT[label] ?? []);
      report(`вкладка «${label}»`, dom, problems);
    }
  } catch (e) {
    failures++;
    console.log(`FAIL вкладки карточки — ${e.message}`);
  }

  console.log(`\nИтог: экранов с дефектами ${failures}; содержательных проверок ${checks}`);

  await close();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`СБОЙ: ${e.message}`);
  process.exit(1);
});