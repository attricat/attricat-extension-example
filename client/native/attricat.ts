/* Helpers shared by the native contributions. Native UI runs in the
 * extension's Worker; it reaches the server only through the host broker. */
import type { useAttricat } from '@attricat/extension';

type Attricat = ReturnType<typeof useAttricat>;

/* Calls a declared server command and returns its payload. */
export const command = async <T>(attricat: Attricat, commandId: string, payload: unknown): Promise<T> => {
  const response = (await attricat.command({ command_id: commandId, payload })) as { payload?: unknown } | null;
  const answer = response && typeof response === 'object' && 'payload' in response ? response.payload : response;
  return (typeof answer === 'string' ? JSON.parse(answer) : answer) as T;
};

/* Reads a value the server component stored in extension storage. */
export const storageGet = async <T>(attricat: Attricat, key: string): Promise<T | null> => {
  const entry = (await attricat.storage.get({ key })) as { value?: T } | null;
  return entry && typeof entry === 'object' && 'value' in entry ? (entry.value ?? null) : null;
};

export const formulaIndexKey = (blueprintId: string, blueprintVersion: number) =>
  `formulas:${blueprintId}:${blueprintVersion}`;

export type FormulaIndex = {
  formulas?: { target_attribute_id: string; expression: string }[];
};
