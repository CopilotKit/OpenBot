import { View } from "react-native";
import type { TablerIcon } from "../icons";
import { BotMarkdown } from "./bot-markdown";
import { cn } from "./cn";
import { Icon } from "./icon";
import { Text } from "./text";

/**
 * A message in a conversation, as the web app draws one: what the person said sits on the right
 * in a quiet bubble; Bot replies render Markdown across the page.
 */
export function Message({
  from,
  text,
  pending,
}: {
  from: "person" | "bot";
  text: string;
  pending?: boolean;
}) {
  if (from === "person") {
    return (
      <View
        className={cn(
          "max-w-[85%] self-end rounded-xl bg-fill px-3.5 py-2.5",
          pending && "opacity-60",
        )}
      >
        <Text selectable>{text}</Text>
      </View>
    );
  }
  return (
    <View className="self-stretch">
      <BotMarkdown text={text} />
    </View>
  );
}

/**
 * A line between messages that says what happened rather than what was said: "You approved
 * computer use.", or a Bot using a tool. Quiet, and set in from the left with its icon.
 */
export function MessageEvent({
  icon,
  text,
}: {
  icon?: TablerIcon;
  text: string;
}) {
  return (
    <View className="flex-row items-center gap-2 self-stretch py-0.5">
      {icon ? <Icon icon={icon} size={14} color="accent-muted" /> : null}
      <Text variant="caption" tone="muted" className="flex-1">
        {text}
      </Text>
    </View>
  );
}

/** The day and time over the messages sent after a pause: "Today, 11:45 AM". */
export function MessageDay({ label }: { label: string }) {
  return (
    <Text
      variant="caption"
      tone="muted"
      className="self-center py-2 font-medium"
      accessibilityRole="header"
    >
      {label}
    </Text>
  );
}
