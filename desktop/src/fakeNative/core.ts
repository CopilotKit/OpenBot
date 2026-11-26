/* `@tauri-apps/api/core`, answered by the fake native side (`control.ts`). */
import { callNative } from "./control";

export function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return callNative(command, args) as Promise<T>;
}

export function convertFileSrc(path: string): string {
  return path;
}
