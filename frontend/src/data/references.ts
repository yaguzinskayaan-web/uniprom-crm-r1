import { useEffect, useState } from 'react';
import { http } from '../api/client';

export interface RefItem {
  value: string;
  label: string;
}

export interface RefBook {
  stages: RefItem[];
  priorities: RefItem[];
  sources: RefItem[];
  currencies: RefItem[];
  complexity: RefItem[];
  taskTypes: RefItem[];
  activityTypes: RefItem[];
  lossReasons: RefItem[];
  units: RefItem[];
}

const STAGES: RefItem[] = [
  { value: 'NEW', label: 'Новая' },
  { value: 'SALES_REVIEW', label: 'Проверка продаж' },
  { value: 'QUOTE_PREPARED', label: 'КП подготовлено' },
  { value: 'KO_QUEUE', label: 'Очередь КО' },
  { value: 'KO_ASSIGNED', label: 'Задано конструктору' },
  { value: 'PREQUOTE_DONE', label: 'Предварительное заключение' },
  { value: 'KO_APPROVED', label: 'Заключение утверждено' },
  { value: 'QUOTE_PRESENTED', label: 'КП направлено' },
  { value: 'QUOTE_NEGOTIATION', label: 'Переговоры' },
  { value: 'CUSTOMER_DECISION', label: 'Решение клиента' },
  { value: 'ORDER_CONFIRMED', label: 'Заказ подтверждён' },
  { value: 'CONTRACT_PENDING', label: 'Ожидает договора' },
  { value: 'CONTRACT_SIGNED', label: 'Договор подписан' },
  { value: 'TO_PRODUCTION', label: 'Выпущена в производство' },
  { value: 'DESIGN_IN_PROGRESS', label: 'Проектирование' },
  { value: 'DESIGN_COMPLETE', label: 'Проектирование завершено' },
  { value: 'MANUFACTURING', label: 'Производство' },
  { value: 'READY_TO_SHIP', label: 'Готово к отгрузке' },
  { value: 'FULFILLMENT', label: 'Исполнение' },
  { value: 'CLOSED', label: 'Закрыта' },
  { value: 'CANCELLED', label: 'Отказ' },
];

const PRIORITIES: RefItem[] = [
  { value: 'LOW', label: 'Низкий' },
  { value: 'NORMAL', label: 'Обычный' },
  { value: 'HIGH', label: 'Высокий' },
  { value: 'CRITICAL', label: 'Критичный' },
];

const SOURCES: RefItem[] = [
  { value: 'MANUAL', label: 'Ручной ввод' },
  { value: 'MAIL', label: 'Входящая почта' },
  { value: 'IMPORT', label: 'Импорт' },
  { value: 'ONE_C', label: '1С' },
  { value: 'SITE', label: 'Сайт' },
  { value: 'REPEAT', label: 'Повторный заказ' },
];

const CURRENCIES: RefItem[] = [
  { value: 'RUB', label: 'RUB · ₽' },
  { value: 'USD', label: 'USD · $' },
  { value: 'EUR', label: 'EUR · €' },
  { value: 'CNY', label: 'CNY · ¥' },
];

const COMPLEXITY: RefItem[] = [
  { value: 'NEEDS_CLASSIFICATION', label: 'Требует классификации' },
  { value: 'STANDARD', label: 'Стандартная' },
  { value: 'MODIFIED', label: 'Модифицированная' },
  { value: 'CUSTOM', label: 'Нестандартная' },
];

const TASK_TYPES: RefItem[] = [
  { value: 'CALL', label: 'Звонок' },
  { value: 'EMAIL', label: 'Письмо' },
  { value: 'MEETING', label: 'Встреча' },
  { value: 'TASK', label: 'Задача' },
  { value: 'FOLLOW_UP', label: 'Контроль' },
  { value: 'OTHER', label: 'Прочее' },
];

const ACTIVITY_TYPES: RefItem[] = [
  { value: 'CALL', label: 'Звонок' },
  { value: 'EMAIL', label: 'Письмо' },
  { value: 'MEETING', label: 'Встреча' },
  { value: 'NOTE', label: 'Заметка' },
  { value: 'SYSTEM', label: 'Системное событие' },
  { value: 'OTHER', label: 'Прочее' },
];

const UNITS: RefItem[] = [
  { value: 'PCS', label: 'шт' },
  { value: 'KG', label: 'кг' },
  { value: 'M', label: 'м' },
  { value: 'M2', label: 'м²' },
  { value: 'M3', label: 'м³' },
  { value: 'T', label: 'т' },
  { value: 'SET', label: 'компл.' },
];

const FALLBACK: RefBook = {
  stages: STAGES,
  priorities: PRIORITIES,
  sources: SOURCES,
  currencies: CURRENCIES,
  complexity: COMPLEXITY,
  taskTypes: TASK_TYPES,
  activityTypes: ACTIVITY_TYPES,
  lossReasons: [],
  units: UNITS,
};

/**
 * Справочники интерфейса. Базовые значения встроены, чтобы форма работала
 * до загрузки справочников с сервера; потери причин отказа и справочников
 * этапов дополняются данными API.
 */
export function useReferences(): { refs: RefBook; loading: boolean } {
  const [refs, setRefs] = useState<RefBook>(FALLBACK);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    Promise.allSettled([
      http.get<{ items: { code: string; label: string }[] }>('/crm/reference/loss-reasons', controller.signal).then((r) =>
        setRefs((prev) => ({ ...prev, lossReasons: (r.items ?? []).map((i) => ({ value: i.code, label: i.label })) })),
      ),
      http
        .get<{ items: { kind: string; code: string; label: string }[] }>('/references?active=true', controller.signal)
        .then((r) => {
          const byKind: Record<string, RefItem[]> = {};
          for (const item of r.items ?? []) (byKind[item.kind] ??= []).push({ value: item.code, label: item.label });
          setRefs((prev) => ({
            ...prev,
            stages: byKind.STAGE?.length ? byKind.STAGE : prev.stages,
            priorities: byKind.PRIORITY?.length ? byKind.PRIORITY : prev.priorities,
            sources: byKind.SOURCE?.length ? byKind.SOURCE : prev.sources,
            currencies: byKind.CURRENCY?.length ? byKind.CURRENCY : prev.currencies,
            units: byKind.UNIT?.length ? byKind.UNIT : prev.units,
            complexity: byKind.COMPLEXITY?.length ? byKind.COMPLEXITY : prev.complexity,
          }));
        }),
    ])
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  return { refs, loading };
}

export const REF_BOOK = FALLBACK;