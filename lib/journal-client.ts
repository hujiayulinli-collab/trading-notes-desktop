import {
  conditionGroups,
  baseRiskPercent,
  type ConditionGroup,
  type Shot,
  type Trade,
} from './journal.ts';

export type Snapshot = {
  records: Trade[];
  revision: number;
  directory: string;
  conditionGroups: ConditionGroup[];
  baseRiskPercent: number;
};
export type JournalClient = {
  cloud: boolean;
  label: string;
  request: <T>(url: string, method?: string, data?: unknown) => Promise<T>;
  imageSource: (shot: Shot) => Promise<string>;
  imageBytes: (shot: Shot) => Promise<Uint8Array<ArrayBuffer>>;
  authorize: () => Promise<void>;
};
export async function localRequest<T>(
  url: string,
  method = 'GET',
  data?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    ...(data === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        }),
  });
  let result: Record<string, unknown>;
  try {
    result = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error('无法连接本地服务，请使用启动程序打开手记。');
  }
  if (!response.ok)
    throw new Error(
      typeof result.error === 'string' ? result.error : '操作失败，请重试。',
    );
  if (url === '/api/journal') {
    result.conditionGroups = conditionGroups(result.conditionGroups);
    result.baseRiskPercent = baseRiskPercent(result.baseRiskPercent);
  }
  return result as T;
}
export const localClient: JournalClient = {
  cloud: false,
  label: '本地资料库',
  request: localRequest,
  imageSource: async (shot) => `/api/screenshots/${shot.id}`,
  imageBytes: async (shot) => {
    const response = await fetch(`/api/screenshots/${shot.id}`);
    if (!response.ok) throw new Error(`无法读取截图“${shot.name}”。`);
    return new Uint8Array(await response.arrayBuffer());
  },
  authorize: async () => {},
};
