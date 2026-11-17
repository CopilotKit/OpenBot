import type { QueryClient } from "@tanstack/react-query";
import { appSetupQueryOptions } from "@/lib/apps/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { pluginKeys } from "./queries";

/** The consents waiting for the window to be back in front, by app key, with how each is confirmed. */
const pending = new Map<string, () => Promise<unknown>>();

/** The client the last consent was started through, which refreshes the lists afterwards. */
let client: QueryClient | null = null;

/**
 * Confirm an app's consent once OpenBot Desktop's window is back in front, whatever screen it is on.
 *
 * The window sends the consent to the person's default browser, and that browser comes back to
 * `/desktop-return`, which is not signed in and asks the API nothing. So the window, which is signed
 * in, confirms the account itself when the person comes back to it, and then reads every plugin list
 * again so Connections, Browse apps and the app's own page all say Connected. Not tied to the screen
 * that started it, because the person may have moved on, and the account's own page leaves it here
 * rather than asking a second time.
 *
 * Once per consent: a second consent for the same app before the window was back waits on the same
 * step. Where each action is authorized on its own, the consent ends at the verifier instead
 * (`finishOnReturn` and `finishInBackground`), so nothing is confirmed here. In a browser the consent
 * comes back to the page that confirms it, so nothing waits.
 */
export function confirmOnReturn(
  queryClient: QueryClient,
  serverId: string,
  confirm: () => Promise<unknown>,
): void {
  if (!desktopShell()) return;
  pending.set(serverId, confirm);
  client = queryClient;
  // One listener for every consent waiting, on whichever window this is.
  window.removeEventListener("focus", confirmPending);
  window.addEventListener("focus", confirmPending, { once: true });
}

async function confirmPending(): Promise<void> {
  const queryClient = client;
  const confirms = [...pending.values()];
  pending.clear();
  client = null;
  if (!queryClient || confirms.length === 0) return;
  const setup = await queryClient
    .fetchQuery(appSetupQueryOptions())
    .catch(() => null);
  if (setup?.authorizesPerAction) return;
  // A refusal is not the window's to report: the lists read again say whether it is connected.
  await Promise.allSettled(confirms.map((ask) => ask()));
  await queryClient.invalidateQueries({ queryKey: pluginKeys.all });
}
