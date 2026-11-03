import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import { useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { colors } from "./ui";

/**
 * Voice typing that never leaves the phone, after Cindy's offline voice input.
 *
 * It uses the phone's own on-device speech recognition (Android 13 and later), with
 * `requiresOnDeviceRecognition` so no sound is sent over the network. The language pack is
 * downloaded once by Android itself, the first time, and after that it works with no
 * connection at all. Words are not masked: the app adds no filter of its own.
 */

type Status =
  | { kind: "idle" }
  | { kind: "listening" }
  | { kind: "needs-pack"; lang: string }
  | { kind: "getting-pack" }
  | { kind: "problem"; message: string };

function phoneLanguage(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}

function join(before: string, words: string): string {
  if (!words) return before;
  if (!before.trim()) return words;
  return `${before.replace(/\s+$/, "")} ${words}`;
}

const PROBLEMS: Record<string, string> = {
  "not-allowed":
    "Voice typing needs the microphone. Allow it in the phone's settings.",
  "language-not-supported":
    "This phone can't type this language by voice offline.",
  "service-not-allowed": "This phone has no offline voice typing.",
  "no-speech": "I didn't hear anything. Tap the mic and try again.",
  "speech-timeout": "I didn't hear anything. Tap the mic and try again.",
  network:
    "Offline voice typing isn't ready yet. Tap the mic to get the speech pack.",
};

/**
 * The mic button for a message box. `text` is what is typed now; spoken words are added after it
 * as they come, and the person can still edit everything before sending.
 */
export function VoiceTypingButton({
  text,
  onText,
  disabled,
}: {
  text: string;
  onText: (next: string) => void;
  disabled?: boolean;
}) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // What was typed when listening started, plus every finished phrase since.
  const kept = useRef("");

  useSpeechRecognitionEvent("result", (event) => {
    const words = event.results[0]?.transcript?.trim() ?? "";
    if (event.isFinal) {
      kept.current = join(kept.current, words);
      onText(kept.current);
    } else {
      onText(join(kept.current, words));
    }
  });
  useSpeechRecognitionEvent("end", () => {
    setStatus((now) => (now.kind === "listening" ? { kind: "idle" } : now));
  });
  useSpeechRecognitionEvent("error", (event) => {
    if (event.error === "aborted") return;
    setStatus({
      kind: "problem",
      message:
        PROBLEMS[event.error] ??
        "Voice typing stopped. Tap the mic to try again.",
    });
  });

  if (Platform.OS === "web") return null;

  async function start() {
    const lang = phoneLanguage();
    if (!ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()) {
      setStatus({
        kind: "problem",
        message: PROBLEMS["service-not-allowed"] ?? "",
      });
      return;
    }
    const permission =
      await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      setStatus({ kind: "problem", message: PROBLEMS["not-allowed"] ?? "" });
      return;
    }
    if (Platform.OS === "android") {
      try {
        const { installedLocales } =
          await ExpoSpeechRecognitionModule.getSupportedLocales({});
        const short = lang.split("-")[0]?.toLowerCase();
        const installed = installedLocales.some(
          (entry) =>
            entry.toLowerCase() === lang.toLowerCase() ||
            entry.split("-")[0]?.toLowerCase() === short,
        );
        if (installedLocales.length > 0 && !installed) {
          setStatus({ kind: "needs-pack", lang });
          return;
        }
      } catch {
        // Some phones can't list their packs; trying to listen says plainly if it's missing.
      }
    }
    kept.current = text;
    setStatus({ kind: "listening" });
    ExpoSpeechRecognitionModule.start({
      lang,
      interimResults: true,
      continuous: true,
      addsPunctuation: true,
      requiresOnDeviceRecognition: true,
      androidIntentOptions: { EXTRA_MASK_OFFENSIVE_WORDS: false },
    });
  }

  async function getPack(lang: string) {
    setStatus({ kind: "getting-pack" });
    try {
      const result =
        await ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({
          locale: lang,
        });
      setStatus(
        result.status === "download_canceled"
          ? { kind: "needs-pack", lang }
          : { kind: "idle" },
      );
    } catch {
      setStatus({
        kind: "problem",
        message:
          "Couldn't get the speech pack. Try again when the phone has a connection.",
      });
    }
  }

  const listening = status.kind === "listening";
  return (
    <View
      style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }}
    >
      <Pressable
        accessibilityLabel={listening ? "Stop voice typing" : "Voice typing"}
        accessibilityRole="button"
        disabled={disabled || status.kind === "getting-pack"}
        onPress={() => {
          if (listening) ExpoSpeechRecognitionModule.stop();
          else void start();
        }}
        style={{
          alignItems: "center",
          justifyContent: "center",
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: listening ? colors.error : colors.link,
          opacity: disabled ? 0.4 : 1,
        }}
      >
        <Text style={{ color: "#ffffff", fontSize: 18 }}>
          {listening ? "■" : "🎤"}
        </Text>
      </Pressable>
      {listening ? (
        <Text style={{ flex: 1, color: colors.muted }}>
          Listening on the phone. Tap ■ to stop.
        </Text>
      ) : null}
      {status.kind === "needs-pack" ? (
        <Pressable
          accessibilityRole="button"
          style={{ flex: 1 }}
          onPress={() => void getPack(status.lang)}
        >
          <Text style={{ color: colors.link }}>
            Get the speech pack (one time, then it works offline)
          </Text>
        </Pressable>
      ) : null}
      {status.kind === "getting-pack" ? (
        <Text style={{ flex: 1, color: colors.muted }}>
          Getting the speech pack…
        </Text>
      ) : null}
      {status.kind === "problem" ? (
        <Text
          accessibilityRole="alert"
          style={{ flex: 1, color: colors.error }}
        >
          {status.message}
        </Text>
      ) : null}
    </View>
  );
}
