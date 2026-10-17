// Feature off until Task 23 replaces it.
/** Whether the Recorder may read websites (<all_urls>), asked for at the first Record on the access page. */
export async function hasHostPermission(): Promise<boolean> {
  return true;
}
