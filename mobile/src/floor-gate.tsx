/**
 * The security floor's notice: when this build is below the floor, one screen covers the whole app,
 * headers included, and nothing behind it can be used until the app is updated.
 *
 * The phone app has no updater of its own; a person updates it from their app store and comes back.
 * "Check again" reads the floor once more, so a floor corrected after it was published lifts the
 * notice without a restart.
 *
 * Checked at launch, when the app comes back to the front, and every six hours while it stays open.
 * The decision itself is in security-floor-check.ts.
 */
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import {
  type ComponentType,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
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
  type FloorStore,
  SECURITY_FLOOR_HEADING,
  SECURITY_FLOOR_LINE,
} from "./security-floor";
import {
  type FloorCheck,
  type FloorDecision,
  heldFloorDecision,
  refreshedFloorDecision,
} from "./security-floor-check";
import { heading } from "./ui";

/** How often an open app reads the floor again. */
const EVERY_MS = 6 * 60 * 60 * 1000;

/** How long the kept floor may hold the first frame. A slow device decides nothing. */
const HELD_WAIT_MS = 2_000;

/** The signed floor as it was published, kept on this phone. */
const KEY = "openbot-security-floor";
const store: FloorStore = {
  read: () => SecureStore.getItemAsync(KEY),
  write: (text) => SecureStore.setItemAsync(KEY, text),
};

/** The OpenBot release this app was built from (app.config.ts sets it from the repository's version). */
const built = (Constants.expoConfig?.extra as { openbotRelease?: unknown })
  ?.openbotRelease;
const release = typeof built === "string" ? built : undefined;

const place: FloorCheck = { origin: serverUrl, release, store };

/**
 * The floor's decision for this build: "starting" for the moment the kept floor is read, then the
 * kept floor's decision, then the published one's.
 */
export function useSecurityFloor() {
  const [decision, setDecision] = useState<FloorDecision | "starting">(
    "starting",
  );
  const [checking, setChecking] = useState(false);
  const running = useRef<Promise<void> | null>(null);
  const check = useCallback(() => {
    running.current ??= (async () => {
      setChecking(true);
      try {
        setDecision(await refreshedFloorDecision(place));
      } finally {
        setChecking(false);
        running.current = null;
      }
    })();
    return running.current;
  }, []);
  useEffect(() => {
    let live = true;
    const waited = setTimeout(
      () =>
        setDecision((now) => (now === "starting" ? { blocked: false } : now)),
      HELD_WAIT_MS,
    );
    void heldFloorDecision(place).then((held) => {
      clearTimeout(waited);
      // A check that finished first read the kept floor too, and anything newer.
      if (live) setDecision((now) => (now === "starting" ? held : now));
      void check();
    });
    const every = setInterval(() => void check(), EVERY_MS);
    const front = AppState.addEventListener("change", (state) => {
      if (state === "active") void check();
    });
    return () => {
      live = false;
      clearTimeout(waited);
      clearInterval(every);
      front.remove();
    };
  }, [check]);
  return { decision, checking, check };
}

export function SecurityFloorGate({
  decision,
  checking,
  onCheck,
}: {
  decision: FloorDecision | "starting";
  checking: boolean;
  onCheck: () => void;
}) {
  if (decision !== "starting" && !decision.blocked) return null;
  return (
    <View style={styles.cover} accessibilityViewIsModal>
      {decision !== "starting" && (
        <View style={styles.body}>
          <Text accessibilityRole="header" style={heading}>
            {SECURITY_FLOOR_HEADING}
          </Text>
          <Text style={styles.line}>{SECURITY_FLOOR_LINE}</Text>
          <View style={styles.action}>
            {checking ? (
              <ActivityIndicator accessibilityLabel="Checking" />
            ) : (
              <Button title="Check again" onPress={onCheck} />
            )}
          </View>
        </View>
      )}
    </View>
  );
}

/** The root layout, with the floor's notice over it whenever this build is below the floor. */
export function withSecurityFloor(Layout: ComponentType) {
  return function SecurityFloorLayout() {
    const { decision, checking, check } = useSecurityFloor();
    return (
      <View style={styles.root}>
        <Layout />
        <SecurityFloorGate
          decision={decision}
          checking={checking}
          onCheck={() => void check()}
        />
      </View>
    );
  };
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  cover: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  body: { gap: 12, width: "100%", maxWidth: 480 },
  line: { fontSize: 16, lineHeight: 22 },
  action: { alignItems: "flex-start", minHeight: 36, justifyContent: "center" },
});
