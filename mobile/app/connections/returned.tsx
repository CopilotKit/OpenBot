import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { fromParams, reportConnectionReturned } from "../../src/connect-app";

/**
 * openbotmobile://connections/returned: where an app's sign-in page sends the browser once the person connected their
 * account (`?appId=`), or didn't (`?error=&appId=`). The browser's sign-in session reads it itself, and the app's
 * screen asks the app whether it is connected (../../src/connect-app.ts). This screen is for the address opening the
 * app outside that session. An app's screen that is open hears it and asks the app again, and this screen goes back
 * to it; with none open, it opens the app's screen, which asks once. It shows nothing of its own.
 */
export default function ConnectionReturned() {
  const params = useLocalSearchParams<{ appId?: string; error?: string }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once, for the address the app was opened at
  useEffect(() => {
    const returned = fromParams(params);
    const heard = reportConnectionReturned(returned);
    if (!heard && returned.appId)
      router.replace({
        pathname: "/connection",
        params: {
          appId: returned.appId,
          returned: "1",
          ...(returned.error ? { error: returned.error } : {}),
        },
      });
    else if (router.canGoBack()) router.back();
    else router.replace("/connections");
  }, []);
  return null;
}
