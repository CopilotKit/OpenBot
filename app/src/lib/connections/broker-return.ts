import { useLocation, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * What an app's broker appends to the page it sends a person back to after its consent screen:
 * `?status=success|failed&connected_account_id=…`.
 */
const BROKER_RETURN = ["status", "connected_account_id"];

/**
 * Drops the broker's report from the address once the page is back.
 *
 * The page never trusts that report: it asks the broker whether the account is live on arrival,
 * and draws what it hears. So the parameters only ride along on every reload and every link
 * somebody copies. Replaced in place, so Back does not return to the address with them.
 */
export function useDropBrokerReturn() {
  const router = useRouter();
  const { pathname, searchStr, hash } = useLocation();
  useEffect(() => {
    const search = new URLSearchParams(searchStr);
    if (!BROKER_RETURN.some((name) => search.has(name))) return;
    for (const name of BROKER_RETURN) search.delete(name);
    const rest = search.toString();
    router.history.replace(
      `${pathname}${rest ? `?${rest}` : ""}${hash ? `#${hash}` : ""}`,
    );
  }, [router, pathname, searchStr, hash]);
}
