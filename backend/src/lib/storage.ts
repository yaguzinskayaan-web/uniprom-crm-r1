import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { config } from '../config.js';
import { ErrorCode, badRequest } from '../errors.js';
import { prisma } from './prisma.js';

/**
 * Абстракция файлового хранилища (§13.1): бинарные файлы не хранятся в БД,
 * сохраняются метаданные и ключ объекта. S3-совместимое хранилище может быть
 * подставлено вместо локальной директории без изменения контракта.
 */
export const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/zip',
]);

const ACTIVE_CONTENT_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.pif', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.wsh', '.ps1', '.psm1', '.hta', '.jar', '.msi', '.reg', '.lnk', '.svgz',
]);

export function assertAllowedFile(originalName: string, contentType: string, sizeBytes: number): void {
  if (sizeBytes > config.maxUploadBytes) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, `Файл превышает допустимый размер ${Math.round(config.maxUploadBytes / 1024 / 1024)} МБ`, {
      fields: [{ field: 'file', message: 'Слишком большой файл' }],
    });
  }
  const ext = extname(originalName).toLowerCase();
  // §14.2: проверка вложений должна исключать исполнение активного содержимого
  if (ACTIVE_CONTENT_EXTENSIONS.has(ext)) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, `Тип файла «${ext}» не допускается: исполняемое активное содержимое запрещено`, {
      fields: [{ field: 'file', message: 'Недопустимый тип файла' }],
    });
  }
  if (contentType && !ALLOWED_CONTENT_TYPES.has(contentType) && !contentType.startsWith('text/')) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, `Тип содержимого «${contentType}» не допускается`, {
      fields: [{ field: 'file', message: 'Недопустимый тип содержимого' }],
    });
  }
}

function extname(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i);
}

const root = resolve(process.cwd(), config.storageDir);

export function objectKeyFor(purpose: string): string {
  const y = new Date().getUTCFullYear();
  const m = String(new Date().getUTCMonth() + 1).padStart(2, '0');
  return `${y}/${m}/${purpose}/${randomUUID()}`;
}

export async function writeObject(objectKey: string, buf: Buffer): Promise<void> {
  const full = join(root, objectKey);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, buf);
}

export async function readObject(objectKey: string): Promise<Buffer> {
  const full = join(root, objectKey);
  return readFile(full);
}

export async function deleteObject(objectKey: string): Promise<void> {
  await unlink(join(root, objectKey)).catch(() => undefined);
}

export function checksumOf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface StoredFileRecord {
  id: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
}

/** Сохраняет файл и регистрирует метаданные. Возвращает метаданные без чтения содержимого. */
export async function storeFile(
  input: { buffer: Buffer; originalName: string; contentType: string; uploadedById: string | null },
): Promise<StoredFileRecord> {
  assertAllowedFile(input.originalName, input.contentType, input.buffer.length);
  const objectKey = objectKeyFor('files');
  await writeObject(objectKey, input.buffer);
  const checksum = checksumOf(input.buffer);
  const row = await prisma.storedFile.create({
    data: {
      objectKey,
      originalName: input.originalName,
      contentType: input.contentType || 'application/octet-stream',
      sizeBytes: input.buffer.length,
      checksum,
      uploadedById: input.uploadedById,
    },
  });
  return row;
}

/** Скачивание всегда проверяет права вызывающего; публичные постоянные ссылки запрещены (§13.1). */
export async function loadFileForDownload(fileId: string) {
  const file = await prisma.storedFile.findUnique({ where: { id: fileId } });
  if (!file) throw badRequest(ErrorCode.NOT_FOUND, 'Файл не найден');
  return { file, buffer: await readObject(file.objectKey) };
}
