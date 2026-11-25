import { useState } from "react";
import { TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { IconArrowUp, IconMicrophone, IconPlus } from "../icons";
import { cn } from "./cn";
import { IconButton } from "./icon-button";

/**
 * The message box, shaped as the web app's: the text across the full width, and under it attach on
 * the left, and speak and send on the right. A flat card at rest that lights in the focus color
 * while someone types in it, the one control that does (docs/app-guidelines.md, "The look").
 */
export function Composer({
  value,
  onChangeText,
  onSend,
  onAttach,
  onSpeak,
  placeholder = "Message",
  disabled,
  sending,
  autoFocus,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onAttach?: () => void;
  onSpeak?: () => void;
  placeholder?: string;
  disabled?: boolean;
  sending?: boolean;
  autoFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const placeholderColor = useCSSVariable("--color-field-placeholder") as
    | string
    | undefined;
  const canSend = value.trim().length > 0 && !disabled && !sending;
  return (
    <View
      className={cn(
        "gap-1 rounded-3xl border bg-surface px-2 pt-2 pb-2",
        focused ? "border-focus" : "border-border",
        disabled && "opacity-60",
      )}
    >
      <TextInput
        accessibilityLabel={placeholder}
        multiline
        autoFocus={autoFocus}
        value={value}
        onChangeText={onChangeText}
        editable={!disabled}
        placeholder={placeholder}
        placeholderTextColor={placeholderColor}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="max-h-36 min-h-10 px-2 pt-1.5 pb-1 font-normal text-base text-field-foreground"
      />
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center">
          {onAttach ? (
            <IconButton
              icon={IconPlus}
              label="Add a file"
              size="sm"
              onPress={onAttach}
              disabled={disabled}
            />
          ) : null}
        </View>
        <View className="flex-row items-center gap-1">
          {onSpeak ? (
            <IconButton
              icon={IconMicrophone}
              label="Speak a message"
              size="sm"
              onPress={onSpeak}
              disabled={disabled}
            />
          ) : null}
          <IconButton
            icon={IconArrowUp}
            label={sending ? "Sending" : "Send"}
            size="sm"
            variant="primary"
            onPress={onSend}
            disabled={!canSend}
          />
        </View>
      </View>
    </View>
  );
}
