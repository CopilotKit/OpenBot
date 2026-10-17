// Feature off until Task 21 replaces it.
export type DesktopHandoff = { openbotUrl: string; code: string };

/** A ping that mints nothing. */
export async function desktopAvailable(): Promise<boolean> {
  return false;
}

export async function askDesktopForHandoff(): Promise<DesktopHandoff | null> {
  return null;
}
