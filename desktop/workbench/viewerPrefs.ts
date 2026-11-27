// Per-viewer preferences of the comment box. They live in
// this browser's localStorage only. Every read and write is in try/catch: a private window or
// blocked site data gives the defaults, and the page still works.

const PREFIX = "workbench.";

export function readPref<T>(
  name: string,
  check: (value: unknown) => value is T,
): T | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + name);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    return check(value) ? value : null;
  } catch {
    return null;
  }
}

export function writePref(name: string, value: unknown): void {
  try {
    if (value === null) window.localStorage.removeItem(PREFIX + name);
    else window.localStorage.setItem(PREFIX + name, JSON.stringify(value));
  } catch {
    // The setting still works until the page closes.
  }
}
