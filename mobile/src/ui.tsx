import { type ReactNode, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";

export const colors = {
  link: "#2563eb",
  error: "#b42318",
  muted: "#6b7280",
  border: "#d1d5db",
  success: "#067647",
  warning: "#b54708",
};

export const card: ViewStyle = {
  gap: 10,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: 8,
  padding: 14,
};
export const heading: TextStyle = { fontSize: 22, fontWeight: "600" };
export const subheading: TextStyle = { fontSize: 18, fontWeight: "600" };
export const muted: TextStyle = { color: colors.muted };
export const input: TextStyle = {
  borderWidth: 1,
  borderColor: "#9ca3af",
  borderRadius: 8,
  padding: 10,
};

/** A pull-to-refresh page. */
export function Screen({
  children,
  refreshing,
  onRefresh,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <ScrollView
      contentContainerStyle={{ padding: 20, gap: 16 }}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={Boolean(refreshing)}
            onRefresh={onRefresh}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  );
}

export function Problem({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <Text accessibilityRole="alert" style={{ color: colors.error }}>
      {message}
    </Text>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 10 }}>
      <Text accessibilityRole="header" style={subheading}>
        {title}
      </Text>
      {children}
    </View>
  );
}

/**
 * One write at a time, with its failure said out loud. `busy` names the action in flight so a
 * screen can disable every control while it runs.
 */
export function useAction() {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function run(name: string, work: () => Promise<unknown>) {
    setBusy(name);
    setError("");
    try {
      await work();
      return true;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not complete this action.",
      );
      return false;
    } finally {
      setBusy("");
    }
  }
  return { busy, error, run, setError };
}
