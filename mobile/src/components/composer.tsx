import { useState } from "react";
import { TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { IconArrowUp, IconMicrophone, IconPlus } from "../icons";
import { cn } from "./cn";
import { IconButton } from "./icon-button";

/**
 * The message box: a flat card at rest that lights in the focus color while someone types in it,
 * the one control that does (docs/app-guidelines.md, "The look"). Attach on the left; speak, or
 * send once there is something to send, on the right.
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
        "flex-row items-end gap-1 rounded-xl border bg-surface p-1.5",
        focused ? "border-focus" : "border-border",
        disabled && "opacity-60",
      )}
    >
      {onAttach ? (
        <IconButton
          icon={IconPlus}
          label="Add a file"
          size="sm"
          onPress={onAttach}
          disabled={disabled}
        />
      ) : null}
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
        className="max-h-36 min-h-8 flex-1 px-2 py-1.5 font-normal text-base text-field-foreground"
      />
      {onSpeak && !value.trim() ? (
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
  );
}
