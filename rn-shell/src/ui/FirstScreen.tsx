import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Colors } from "./theme";

/**
 * The first screen: native, drawn without the network. While the app decides at launch it shows the
 * mark and the name alone (the same picture as the launch screen); signed out it adds the line and
 * the Sign in button.
 */
export function FirstScreen(props: {
  colors: Colors;
  launching: boolean;
  busy: boolean;
  message: string | null;
  onSignIn: () => void;
  onLayout?: () => void;
}) {
  const { colors, launching, busy, message } = props;
  const insets = useSafeAreaInsets();
  return (
    <View
      testID="sign-in-screen"
      onLayout={props.onLayout}
      style={[StyleSheet.absoluteFill, styles.screen, { backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom + 24 }]}
    >
      <View style={styles.center}>
        <Image source={require("../../assets/openbot-mark.png")} style={styles.mark} accessibilityIgnoresInvertColors accessible={false} />
        <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]}>
          OpenBot
        </Text>
        {launching ? null : (
          <Text style={[styles.line, { color: colors.mutedForeground }]}>
            Sign in to talk to your Bots and pick up your conversations.
          </Text>
        )}
      </View>
      {launching ? null : (
        <View style={styles.bottom}>
          {message ? (
            <Text testID="sign-in-message" style={[styles.message, { color: colors.mutedForeground }]}>
              {message}
            </Text>
          ) : null}
          <Pressable
            testID="sign-in-button"
            accessibilityRole="button"
            accessibilityLabel={busy ? "Signing in" : "Sign in"}
            accessibilityState={{ disabled: busy, busy }}
            disabled={busy}
            onPress={props.onSignIn}
            style={({ pressed }) => [styles.button, { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 }]}
          >
            {busy ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Sign in</Text>
            )}
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { alignItems: "center" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 32, maxWidth: 520, gap: 12 },
  mark: { width: 72, height: 72, marginBottom: 8 },
  title: { fontSize: 40, fontWeight: "600" },
  line: { fontSize: 17, textAlign: "center", lineHeight: 24 },
  bottom: { alignSelf: "stretch", paddingHorizontal: 24, gap: 12, maxWidth: 520, width: "100%", marginHorizontal: "auto" },
  message: { fontSize: 13, textAlign: "center" },
  button: { height: 52, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 17, fontWeight: "600" },
});
