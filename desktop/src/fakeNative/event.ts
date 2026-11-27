/* `@tauri-apps/api/event`, answered by the fake native side (`control.ts`). */
import { listenNative } from "./control";

export function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  return Promise.resolve(
    listenNative(event, (e) => handler(e as { payload: T })),
  );
}
