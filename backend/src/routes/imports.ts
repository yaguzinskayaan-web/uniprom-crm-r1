import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { ctx, requireAuth } from './context.js';
import { confirmBatch, createBatch, getBatch, IMPORT_ROW_LIMIT, listBatches, type ImportSource } from '../services/imports.js';
import { checksumOf } from '../lib/storage.js';
import { detectFormat, FileParseError, parseSheet, toNumber } from '../lib/importFile.js';
import { ErrorCode, badRequest } from '../errors.js';
import { P, assertPermission } from '../domain/rbac.js';

/**
 * Импорт Excel/CSV (§5.3): сопоставление колонок → предварительная проверка →
 * предпросмотр → подтверждение. Макросы и формулы не исполняются: принимается
 * только текстовое содержимое ячеек.
 */

const batchParams = z.object({ batchId: z.string().min(1) });

const rowSchema = z.object({
  groupId: z.string().default(''),
  externalNumber: z.string().optional(),
  organizationName: z.string().default(''),
  inn: z.string().optional(),
  kpp: z.string().optional(),
  contactName: z.string().optional(),
  contactPhone: z.string().optional(),
  contactEmail: z.string().optional(),
  lineId: z.string().optional(),
  lineName: z.string().default(''),
  quantity: z.coerce.number().default(0),
  unit: z.string().optional(),
  price: z.coerce.number().optional(),
  rowNo: z.number().int().min(1),
});

const mappingSchema = z.object({
  groupId: z.string().min(1, 'Укажите колонку с идентификатором группы'),
  organizationName: z.string().min(1, 'Укажите колонку с наименованием контрагента'),
  lineName: z.string().min(1, 'Укажите колонку с номенклатурой'),
  quantity: z.string().min(1, 'Укажите колонку с количеством'),
  externalNumber: z.string().optional(),
  inn: z.string().optional(),
  kpp: z.string().optional(),
  contactName: z.string().optional(),
  contactPhone: z.string().optional(),
  contactEmail: z.string().optional(),
  lineId: z.string().optional(),
  unit: z.string().optional(),
  price: z.string().optional(),
});

const uploadBody = z.object({
  fileName: z.string().min(1),
  source: z.enum(['EXCEL', 'CSV']).default('EXCEL'),
  mapping: mappingSchema,
  rows: z.array(rowSchema).min(1, 'Файл не содержит строк для импорта'),
});

const confirmBody = z.object({
  onlyGroupIds: z.array(z.string().min(1)).optional(),
});

/** Приём единственного файла из multipart-тела. */
async function readUploadedFile(
  req: FastifyRequest,
  withMapping = false,
): Promise<{ buffer: Buffer; filename: string; mappingRaw?: string }> {
  let buffer: Buffer | undefined;
  let filename = '';
  let mappingRaw: string | undefined;

  for await (const part of req.parts()) {
    if (part.type === 'file') {
      if (buffer) throw badRequest(ErrorCode.VALIDATION_ERROR, 'Передайте один файл за раз');
      buffer = await part.toBuffer();
      filename = part.filename || 'import.csv';
    } else if (withMapping && part.fieldname === 'mapping') {
      mappingRaw = part.value as string;
    }
  }

  if (!buffer) throw badRequest(ErrorCode.VALIDATION_ERROR, 'Файл не передан');
  if (buffer.length === 0) throw badRequest(ErrorCode.VALIDATION_ERROR, 'Файл пустой');
  return { buffer, filename, mappingRaw };
}

function parseMappingField(raw: string | undefined): z.infer<typeof mappingSchema> {
  if (!raw) throw badRequest(ErrorCode.VALIDATION_ERROR, 'Не передано сопоставление колонок');
  try {
    return mappingSchema.parse(JSON.parse(raw));
  } catch (e) {
    if (e instanceof ZodError) throw badRequest(ErrorCode.VALIDATION_ERROR, e.issues[0]?.message ?? 'Некорректное сопоставление колонок');
    throw badRequest(ErrorCode.VALIDATION_ERROR, 'Сопоставление колонок передано в неверном формате');
  }
}

async function parseOrFail(buffer: Buffer, filename: string): ReturnType<typeof parseSheet> {
  try {
    return await parseSheet(filename, buffer);
  } catch (e) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, e instanceof FileParseError ? e.message : 'Не удалось разобрать файл');
  }
}

/** Приведение строки файла к модели импорта по сопоставлению колонок. */
function mapRow(
  raw: Record<string, string>,
  mapping: z.infer<typeof mappingSchema>,
  rowNo: number,
): Record<string, unknown> {
  const pick = (column: string | undefined): string | undefined => {
    if (!column) return undefined;
    const value = raw[column];
    return value === undefined ? undefined : value;
  };
  return {
    groupId: pick(mapping.groupId) ?? '',
    externalNumber: pick(mapping.externalNumber),
    organizationName: pick(mapping.organizationName) ?? '',
    inn: pick(mapping.inn),
    kpp: pick(mapping.kpp),
    contactName: pick(mapping.contactName),
    contactPhone: pick(mapping.contactPhone),
    contactEmail: pick(mapping.contactEmail),
    lineId: pick(mapping.lineId),
    lineName: pick(mapping.lineName) ?? '',
    quantity: toNumber(pick(mapping.quantity)) ?? 0,
    unit: pick(mapping.unit),
    price: toNumber(pick(mapping.price)),
    rowNo,
  };
}

const { importInspect, importUpload } = importHandlers();

export async function importRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAuth() };

  app.get('/api/v1/imports', auth, async (req) => {
    const { principal } = ctx(req);
    return listBatches(principal);
  });

  app.get('/api/v1/imports/:batchId', auth, async (req) => {
    const { principal } = ctx(req);
    const { batchId } = batchParams.parse(req.params);
    return getBatch(batchId, principal);
  });

  /** Приём файла и предварительная проверка: ничего не создаётся в заявках. */
  app.post('/api/v1/imports/validate', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const body = uploadBody.parse(req.body);
    if (body.rows.length > IMPORT_ROW_LIMIT) {
      return { error: `Пакет до ${IMPORT_ROW_LIMIT} строк` } as never;
    }
    // Отпечаток пакета: содержимое файла + сопоставление колонок (IMP-03)
    const checksum = checksumOf(Buffer.from(`${body.fileName}:${JSON.stringify(body.rows)}`, 'utf8'));
    return createBatch({
      source: body.source as ImportSource,
      fileName: body.fileName,
      checksum,
      mapping: body.mapping,
      rows: body.rows,
      correlationId,
      actor: principal,
    });
  });

  app.post('/api/v1/imports/:batchId/confirm', auth, async (req) => {
    const { principal, correlationId } = ctx(req);
    const { batchId } = batchParams.parse(req.params);
    const body = confirmBody.parse(req.body ?? {});
    return confirmBatch({ id: batchId, onlyGroupIds: body.onlyGroupIds, correlationId, actor: principal });
  });

  app.post('/api/v1/imports/inspect', auth, importInspect);
  app.post('/api/v1/imports/upload', auth, importUpload);
}

/**
 * Файловые обработчики импорта. Вынесены наружу, чтобы контрактные алиасы
 * `/api/v1/crm/imports/*` вели себя идентично каноническим маршрутам: те же
 * правила разбора, сопоставления колонок и проверки прав.
 */
export function importHandlers(): {
  importInspect: (req: FastifyRequest) => Promise<unknown>;
  importUpload: (req: FastifyRequest) => Promise<unknown>;
} {
  /** Определение колонок файла до загрузки: пользователь сопоставляет
   * заголовки с полями шаблона, ничего не отправляя в базу (IMP-02). */
  const importInspect = async (req: FastifyRequest) => {
    const { principal } = ctx(req);
    assertPermission(principal.role as never, P.IMPORT_RUN, 'Импорт заявок недоступен для вашей роли.');
    const file = await readUploadedFile(req);
    const sheet = await parseOrFail(file.buffer, file.filename);
    return {
      fileName: file.filename,
      format: detectFormat(file.filename, file.buffer),
      headers: sheet.headers,
      rowCount: sheet.rows.length,
      limit: IMPORT_ROW_LIMIT,
      sample: sheet.rows.slice(0, 5),
    };
  };

  const importUpload = async (req: FastifyRequest) => {
    const { principal, correlationId } = ctx(req);
    const file = await readUploadedFile(req, true);
    const mapping = parseMappingField(file.mappingRaw);
    const sheet = await parseOrFail(file.buffer, file.filename);

    // Все колонки сопоставления должны существовать в файле (IMP-02).
    const declared = Object.values(mapping).filter((v): v is string => typeof v === 'string');
    const missing = declared.filter((col) => !sheet.headers.includes(col));
    if (missing.length > 0) {
      return { error: 'В файле нет указанных колонок', missingColumns: missing, headers: sheet.headers };
    }
    if (sheet.rows.length > IMPORT_ROW_LIMIT) {
      return {
        error: `Пакет до ${IMPORT_ROW_LIMIT} строк, в файле ${sheet.rows.length}`,
        headers: sheet.headers,
        rowCount: sheet.rows.length,
      };
    }

    const rows = sheet.rows.map((raw, i) => rowSchema.parse(mapRow(raw, mapping, sheet.rowNumbers[i] ?? i + 2)));
    const source: ImportSource = detectFormat(file.filename, file.buffer) === 'XLSX' ? 'EXCEL' : 'CSV';

    return createBatch({
      source,
      fileName: file.filename,
      checksum: checksumOf(file.buffer),
      mapping,
      rows,
      correlationId,
      actor: principal,
    });
  };

  return { importInspect, importUpload };
}
