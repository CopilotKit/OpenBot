/**
 * The screen the root layout shows in place of the app when the app is too old for its OpenBot ("Update OpenBot"). It
 * covers everything, headers included, so nothing behind it is shown failing.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Button,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { serverUrl } from "./auth";
import {
  APP_UPDATE_SENTENCE,
  onUpdateRequired,
  type VersionVerdict,
} from "./client-version";
import { heading, muted } from "./ui";
import { checkVersion } from "./version-check";

/** How long the check may hold the app before it opens anyway: a slow network decides nothing. */
const CHECK_WAIT_MS = 8_000;

/** The decision, asked as the app opens and each time it comes back to the front, and changed by any refusal. */
export function useVersionVerdict() {
  const [verdict, setVerdict] = useState<VersionVerdict | "checking">(
    "checking",
  );
  const check = useCallback(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<VersionVerdict>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "ok" }), CHECK_WAIT_MS);
    });
    const decided = await Promise.race([checkVersion(), waited]);
    clearTimeout(timer);
    setVerdict(decided);
  }, []);
  useEffect(() => {
    void check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void check();
    });
    const stop = onUpdateRequired((detail) =>
      setVerdict({ kind: "app", detail }),
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
  if (verdict !== "checking" && verdict.kind === "ok") return null;
  return (
    <View style={styles.cover} accessibilityViewIsModal>
      {verdict === "checking" ? (
        <ActivityIndicator accessibilityLabel="Checking OpenBot" />
      ) : (
        <View style={styles.body}>
          <Text accessibilityRole="header" style={heading}>
            {APP_UPDATE_SENTENCE}
          </Text>
          <Text style={styles.sentence}>{verdict.detail}</Text>
          <Text style={muted}>{serverUrl}</Text>
          <View style={styles.action}>
            <Button title="Try again" onPress={onRetry} />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  cover: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  body: { gap: 12, width: "100%", maxWidth: 480 },
  sentence: { fontSize: 16, lineHeight: 22 },
  action: { alignItems: "flex-start" },
});
