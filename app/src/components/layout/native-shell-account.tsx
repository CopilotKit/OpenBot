import { StripAccount } from "@/components/app-sidebar/section-strip";
import { nativeShell } from "@/lib/native-shell/shell";

/** The account button's name in the native shell, the same whoever is signed in. */
export const SHELL_ACCOUNT_LABEL = "Account";

/**
 * The sidebar's account menu (Settings, Admin, Sign out and the rest), at the top right of the
 * phone app's tab pages: Home, Conversations and Bots. Only inside the native shell, which has no
 * sidebar to reach them by (`lib/native-shell`). The same menu, opening below the avatar, with the
 * button and the rows at a thumb's size.
 */
export function ShellAccountMenu() {
  if (!nativeShell()) return null;
  return <StripAccount label={SHELL_ACCOUNT_LABEL} large side="bottom" />;
}
