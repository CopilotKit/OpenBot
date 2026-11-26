import { Button } from "heroui-native/button";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { IconChevronDown, IconChevronRight, IconTool } from "../icons";
import { Icon } from "./icon";
import { Text } from "./text";

/**
 * What a Bot did between two things it said, folded into one quiet line, as the web app's transcript
 * folds a run of steps: "Took 3 steps", which opens to each one. A single step is its own line. The
 * transcript keeps the Bot's words and the person's in front, and the working out behind a tap.
 */
export function StepsLine({ steps }: { steps: string[] }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 1)
    return (
      <View className="flex-row items-start gap-2">
        <View className="pt-0.5">
          <Icon icon={IconTool} size={14} color="accent-muted" />
        </View>
        <Text tone="muted" className="flex-1 text-sm leading-5">
          {steps[0]}
        </Text>
      </View>
    );
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Took ${steps.length} steps`}
        accessibilityHint={open ? "Hides them" : "Shows each one"}
        hitSlop={8}
        onPress={() => setOpen((now) => !now)}
        className="flex-row items-center gap-2 self-start active:opacity-60"
      >
        <Icon icon={IconTool} size={14} color="accent-muted" />
        <Text tone="muted" className="text-sm leading-5">
          Took {steps.length} steps
        </Text>
        <Icon
          icon={open ? IconChevronDown : IconChevronRight}
          size={12}
          color="accent-muted"
        />
      </Pressable>
      {open ? (
        <View className="mt-2 ml-1.5 gap-1.5 border-border border-l pl-3">
          {steps.map((step, index) => (
            <Text
              // biome-ignore lint/suspicious/noArrayIndexKey: the steps of one run, in their order
              key={index}
              tone="muted"
              className="text-sm leading-5"
            >
              {step}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Something a Bot needs the person to decide, in the chat where it asked, as the web app's decision
 * card: what it wants to do, why it asks, what it would do it with, and the answers. A card, since it
 * is the one thing in the transcript that waits on a tap.
 */
export function DecisionCard({
  title,
  caption,
  details,
  choices,
  standing,
  busy,
}: {
  title: string;
  caption?: string;
  details: { label: string; value: string }[];
  choices: { label: string; primary: boolean; onPress: () => void }[];
  standing?: { label: string; onPress: () => void };
  busy?: boolean;
}) {
  return (
    <View
      accessibilityLabel={`Waiting for your approval: ${title}`}
      className="gap-3 rounded-xl border border-border bg-surface p-4"
    >
      <View className="gap-0.5">
        <Text className="font-semibold text-[15px] leading-5">{title}</Text>
        {caption ? (
          <Text tone="muted" className="text-sm leading-5">
            {caption}
          </Text>
        ) : null}
      </View>
      {details.length ? (
        <View className="gap-1">
          {details.map((line) => (
            <View key={line.label} className="flex-row gap-3">
              <Text tone="muted" className="w-20 text-sm leading-5">
                {line.label}
              </Text>
              <Text className="flex-1 text-sm leading-5">{line.value}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <View className="flex-row gap-2">
        {choices.map((choice) => (
          <Button
            key={choice.label}
            size="sm"
            className="flex-1"
            variant={choice.primary ? "primary" : "secondary"}
            isDisabled={busy}
            onPress={choice.onPress}
          >
            {choice.label}
          </Button>
        ))}
      </View>
      {standing ? (
        <Button
          size="sm"
          variant="ghost"
          isDisabled={busy}
          onPress={standing.onPress}
        >
          {standing.label}
        </Button>
      ) : null}
    </View>
  );
}
