/**
 * The screen the root layout shows in place of the app when the app is too old for its OpenBot ("Update OpenBot", or
 * the security sentence when the minimum was raised for a security problem). It covers everything, headers included,
 * so nothing behind it is shown failing.
 */

import { Button } from "heroui-native/button";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, AppState, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { serverUrl } from "./auth";
import {
  APP_UPDATE_SENTENCE,
  onUpdateRequired,
  SECURITY_UPDATE_SENTENCE,
  type VersionVerdict,
} from "./client-version";
import { Text } from "./components";
import { checkVersion } from "./version-check";

/** How long the check may hold the app before it opens anyway: a slow network decides nothing. */
const CHECK_WAIT_MS = 8_000;

/** The decision, asked as the app opens and each time it comes back to the front, and changed by any refusal. */
export function useVersionVerdict(signedIn: boolean, sessionPending = false) {
  const [verdict, setVerdict] = useState<VersionVerdict | "checking">(
    "checking",
  );
  const check = useCallback(async () => {
    // Not before the session has answered: which organization's deployment to read depends on it.
    if (sessionPending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<VersionVerdict>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "ok" }), CHECK_WAIT_MS);
    });
    const decided = await Promise.race([checkVersion(signedIn), waited]);
    clearTimeout(timer);
    setVerdict(decided);
  }, [signedIn, sessionPending]);
  useEffect(() => {
    void check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void check();
    });
    const stop = onUpdateRequired((detail, security) =>
      setVerdict(
        security
          ? { kind: "app", detail, security: true }
          : { kind: "app", detail },
      ),
    );
    return () => {
      subscription.remove();
      stop();
    };
  }, [check]);
  return { verdict, check };
}

export function VersionGate({
  verdict,
  onRetry,
}: {
  verdict: VersionVerdict | "checking";
  onRetry: () => void;
}) {
  const muted = useCSSVariable("--color-muted") as string | undefined;
  if (verdict !== "checking" && verdict.kind === "ok") return null;
  return (
    <View
      className="absolute inset-0 items-center justify-center bg-background px-6"
      accessibilityViewIsModal
    >
      {verdict === "checking" ? (
        <ActivityIndicator
          color={muted}
          accessibilityLabel="Checking OpenBot"
        />
      ) : (
        <View className="w-full max-w-[480px] gap-3">
          {verdict.security ? (
            // The security sentence is the heading, and says what to do: nothing repeats it below.
            <Text variant="title">{SECURITY_UPDATE_SENTENCE}</Text>
          ) : (
            <>
              <Text variant="title">{APP_UPDATE_SENTENCE}</Text>
              <Text>{verdict.detail}</Text>
            </>
          )}
          <Text variant="caption" tone="muted">
            {serverUrl}
          </Text>
          <Button className="mt-2 self-start" onPress={onRetry}>
            Try again
          </Button>
        </View>
      )}
    </View>
  );
}
