import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * A44: резервное копирование и восстановление CRM.
 *
 * Комплект состоит из базы данных SQLite, каталога загруженных файлов и манифеста
 * с контрольными суммами. Восстановление проверяет манифест до замены данных и
 * отказывается продолжать, если он повреждён, — иначе «восстановление» молча
 * оставило бы систему в несогласованном состоянии.
 *
 * Использование:
 *   npx tsx scripts/backup.ts create [каталог]
 *   npx tsx scripts/backup.ts restore <каталог комплекта> [--force]
 *   npx tsx scripts/backup.ts verify <каталог комплекта>
 *   npx tsx scripts/backup.ts list [каталог]
 *
 * ВНИМАНИЕ: перед `restore` остановите backend. Скрипт не останавливает процесс
 * сам, чтобы не прервать работу без явного намерения.
 */

const BACKEND_DIR = resolve(process.cwd());
const DB_PATH = resolve(join(BACKEND_DIR, 'prisma', 'prisma', 'crm.db'));
const STORAGE_DIR = resolve(join(BACKEND_DIR, process.env.STORAGE_DIR?.replace(/^\.\//, '') ?? 'var/storage'));
const DEFAULT_BACKUP_DIR = resolve(join(BACKEND_DIR, 'var', 'backups'));

interface Manifest {
  formatVersion: 1;
  createdAt: string;
  database: { file: string; bytes: number; sha256: string };
  storage: { file: string; entries: number; bytes: number; sha256: string };
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function dirDigest(dir: string): { entries: number; bytes: number; sha256: string } {
  const parts: string[] = [];
  let entries = 0;
  let bytes = 0;
  const walk = (current: string, rel: string): void => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, relPath);
        continue;
      }
      entries += 1;
      bytes += statSync(full).size;
      parts.push(`${relPath}:${sha256(full)}`);
    }
  };
  walk(dir, '');
  return { entries, bytes, sha256: createHash('sha256').update(parts.join('\n')).digest('hex') };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`ОШИБКА: ${message}\n`);
  process.exit(1);
}

function create(target?: string): void {
  if (!existsSync(DB_PATH)) fail(`База данных не найдена: ${DB_PATH}`);

  const root = resolve(target ?? DEFAULT_BACKUP_DIR);
  const dir = join(root, `crm-${stamp()}`);
  mkdirSync(join(dir, 'storage'), { recursive: true });

  const dbTarget = join(dir, 'crm.db');
  // WAL-файлы копируются вместе с базой: без них незакрытые изменения теряются.
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${DB_PATH}${suffix}`;
    if (existsSync(src)) copyFileSync(src, dbTarget + suffix);
  }

  if (existsSync(STORAGE_DIR)) {
    cpSync(STORAGE_DIR, join(dir, 'storage'), { recursive: true });
  }

  const manifest: Manifest = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    database: {
      file: 'crm.db',
      bytes: statSync(dbTarget).size,
      sha256: sha256(dbTarget),
    },
    storage: { file: 'storage', ...dirDigest(join(dir, 'storage')) },
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  log(`Комплект создан: ${dir}`);
  log(`  база: ${manifest.database.bytes} байт, sha256 ${manifest.database.sha256.slice(0, 16)}…`);
  log(`  файлы: ${manifest.storage.entries} шт., ${manifest.storage.bytes} байт`);
}

function verify(dir: string): Manifest {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) fail(`Манифест не найден: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

  if (manifest.formatVersion !== 1) fail(`Неизвестный формат комплекта: ${manifest.formatVersion}`);

  const dbTarget = join(dir, manifest.database.file);
  if (!existsSync(dbTarget)) fail(`Файл базы отсутствует в комплекте: ${dbTarget}`);
  const dbHash = sha256(dbTarget);
  if (dbHash !== manifest.database.sha256) {
    fail(`Контрольная сумма базы не совпадает.\n  ожидалось: ${manifest.database.sha256}\n  получено:  ${dbHash}`);
  }

  const actualStorage = dirDigest(join(dir, manifest.storage.file));
  if (actualStorage.sha256 !== manifest.storage.sha256) {
    fail(
      `Контрольная сумма файлов не совпадает.\n  ожидалось: ${manifest.storage.sha256}\n  получено:  ${actualStorage.sha256}`,
    );
  }

  return manifest;
}

function restore(dir: string, force: boolean): void {
  if (!existsSync(dir)) fail(`Комплект не найден: ${dir}`);
  const manifest = verify(dir);
  log(`Комплект проверен: ${manifest.createdAt}`);

  if (!force) {
    log('Укажите --force, чтобы подтвердить замену рабочих данных.');
    return;
  }

  for (const suffix of ['', '-wal', '-shm']) {
    const dst = `${DB_PATH}${suffix}`;
    if (existsSync(dst)) rmSync(dst, { force: true });
    const src = join(dir, `${manifest.database.file}${suffix}`);
    if (existsSync(src)) copyFileSync(src, dst);
  }
  log(`База восстановлена: ${DB_PATH}`);

  const storageSrc = join(dir, manifest.storage.file);
  if (existsSync(STORAGE_DIR)) rmSync(STORAGE_DIR, { recursive: true, force: true });
  mkdirSync(STORAGE_DIR, { recursive: true });
  if (existsSync(storageSrc)) cpSync(storageSrc, STORAGE_DIR, { recursive: true });
  log(`Файлы восстановлены: ${STORAGE_DIR} (${manifest.storage.entries} шт.)`);

  log('Проверка согласованности базы и схемы выполняется командой `npm run migrate:verify`.');
  log('Запустите backend и убедитесь, что очереди в состоянии PENDING/QUEUED (см. статус интеграций).');
}

function list(target?: string): void {
  const root = resolve(target ?? DEFAULT_BACKUP_DIR);
  if (!existsSync(root)) {
    log(`Каталог комплектов не найден: ${root}`);
    return;
  }
  const rows = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const manifestPath = join(root, e.name, 'manifest.json');
      if (!existsSync(manifestPath)) return null;
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
      return { dir: e.name, createdAt: m.createdAt, db: m.database.bytes, files: m.storage.entries };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (!rows.length) {
    log(`Комплектов нет: ${root}`);
    return;
  }
  for (const r of rows) log(`${r.createdAt}  db=${r.db} Б  файлов=${r.files}  ${r.dir}`);
}

const [command, ...rest] = process.argv.slice(2);
const force = rest.includes('--force');
const args = rest.filter((a) => a !== '--force');

switch (command) {
  case 'create':
    create(args[0]);
    break;
  case 'verify':
    verify(resolve(args[0] ?? ''));
    log('Комплект целостен.');
    break;
  case 'restore':
    restore(resolve(args[0] ?? ''), force);
    break;
  case 'list':
    list(args[0]);
    break;
  default:
    fail('Укажите команду: create | verify | restore | list');
}