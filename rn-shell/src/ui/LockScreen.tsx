import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CloudOffIcon } from "./Icons";
import type { Colors } from "./theme";

export const LOCK_HEADING = "Cannot reach the OpenBot backend";
export const LOCK_BODY =
  "For security purposes, this application can only be used when connected to the OpenBot backend. Please check your internet connection, VPC configuration and network settings to make sure this device can reach the OpenBot backend. Contact your system administrator if you are unable to connect.";
export const SUPPORT_ADDRESS = "support@open.bot";

/** Covers everything when the backend cannot be reached: no network, or the web app did not load. */
export function LockScreen(props: {
  colors: Colors;
  reason: string;
  onRetry: () => void;
}) {
  const { colors } = props;
  const insets = useSafeAreaInsets();
  return (
    <View
      testID="offline-lock"
      accessibilityValue={{ text: props.reason }}
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor: colors.background,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      <ScrollView contentContainerStyle={styles.content} bounces={false}>
        <CloudOffIcon color={colors.mutedForeground} size={44} />
        <Text
          accessibilityRole="header"
          style={[styles.heading, { color: colors.foreground }]}
        >
          {LOCK_HEADING}
        </Text>
        <Text style={[styles.body, { color: colors.mutedForeground }]}>
          {LOCK_BODY}
        </Text>
        <Pressable
          testID="retry-button"
          accessibilityRole="button"
          accessibilityLabel="Try again"
          onPress={props.onRetry}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
          ]}
        >
          <Text
            style={[styles.buttonText, { color: colors.primaryForeground }]}
          >
            Try again
          </Text>
        </Pressable>
        <Pressable
          testID="support-email"
          accessibilityRole="link"
          accessibilityLabel={`Need help? ${SUPPORT_ADDRESS}`}
          onPress={() =>
            void Linking.openURL(`mailto:${SUPPORT_ADDRESS}`).catch(
              () => undefined,
            )
          }
          hitSlop={8}
        >
          <Text style={[styles.help, { color: colors.mutedForeground }]}>
            Need help?{" "}
            <Text style={[styles.link, { color: colors.foreground }]}>
              {SUPPORT_ADDRESS}
            </Text>
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 28,
    paddingVertical: 32,
    gap: 16,
  },
  heading: { fontSize: 22, fontWeight: "600", textAlign: "center" },
  body: { fontSize: 15, lineHeight: 22, textAlign: "center", maxWidth: 480 },
  button: {
    marginTop: 8,
    height: 48,
    minWidth: 180,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: 16, fontWeight: "600" },
  help: { fontSize: 14, textAlign: "center" },
  link: { textDecorationLine: "underline" },
});
