import MenuView from "@expo/ui/community/menu";
import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useCSSVariable } from "uniwind";
import {
  IconArrowUp,
  IconChevronDown,
  IconFile,
  IconMicrophone,
  IconPhoto,
  IconPlus,
  IconX,
} from "../icons";
import { cn } from "./cn";
import { Icon } from "./icon";
import { IconButton } from "./icon-button";
import { Text } from "./text";

/** Where a file to attach comes from: the phone's photos, or its files. */
export type AttachFrom = "photos" | "files";

/** A file waiting to go with the next message: still uploading, or held by the server. */
export type ComposerFile = {
  key: string;
  name: string;
  image: boolean;
  /** A photo's own address on the phone, for its thumbnail. */
  preview?: string;
  uploading: boolean;
};

/** The model the next reply runs on, and the ones the person may pick. */
export type ComposerModels = {
  label: string;
  options: { id: string; label: string; chosen: boolean }[];
  onPick: (id: string) => void;
};

/**
 * The message box, shaped as the web app's: the text across the full width, the files going with it
 * above, and under it attach on the left, and the model, speak and send on the right. A flat card at
 * rest that lights in the focus color while someone types in it, the one control that does
 * (docs/app-guidelines.md, "The look"). Attach and the model are the platform's own menus.
 */
export function Composer({
  value,
  onChangeText,
  onSend,
  onAttach,
  files = [],
  onRemoveFile,
  models,
  onSpeak,
  placeholder = "Message",
  disabled,
  sending,
  autoFocus,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onAttach?: (from: AttachFrom) => void;
  files?: ComposerFile[];
  onRemoveFile?: (key: string) => void;
  models?: ComposerModels;
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
  const uploading = files.some((file) => file.uploading);
  const canSend =
    value.trim().length > 0 && !disabled && !sending && !uploading;
  return (
    <View
      className={cn(
        "gap-1 rounded-3xl border bg-surface px-2 pt-2 pb-2",
        focused ? "border-focus" : "border-border",
        disabled && "opacity-60",
      )}
    >
      {files.length ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 px-1 pb-1"
        >
          {files.map((file) => (
            <View
              key={file.key}
              className="max-w-52 flex-row items-center gap-1.5 rounded-lg bg-fill py-1.5 pr-1 pl-2.5"
            >
              {file.preview ? (
                <View className="size-7 overflow-hidden rounded-md bg-background">
                  <Image
                    source={{ uri: file.preview }}
                    className="size-7"
                    accessibilityIgnoresInvertColors
                  />
                  {file.uploading ? (
                    <View className="absolute inset-0 items-center justify-center bg-background/60">
                      <ActivityIndicator size="small" />
                    </View>
                  ) : null}
                </View>
              ) : file.uploading ? (
                <ActivityIndicator size="small" />
              ) : (
                <Icon
                  icon={file.image ? IconPhoto : IconFile}
                  size={14}
                  color="accent-muted"
                />
              )}
              <Text numberOfLines={1} className="shrink text-sm">
                {file.name}
              </Text>
              {onRemoveFile ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${file.name}`}
                  hitSlop={8}
                  onPress={() => onRemoveFile(file.key)}
                  className="size-6 items-center justify-center rounded-full active:bg-background"
                >
                  <Icon icon={IconX} size={14} color="accent-muted" />
                </Pressable>
              ) : null}
            </View>
          ))}
        </ScrollView>
      ) : null}
      <TextInput
        accessibilityLabel={placeholder}
        multiline
        // The most a message can be, as the API takes it.
        maxLength={16000}
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
            <MenuView
              actions={[
                { id: "photos", title: "Photo Library", image: "photo" },
                { id: "files", title: "Files", image: "folder" },
              ]}
              onPressAction={({ nativeEvent }) =>
                onAttach(nativeEvent.event === "files" ? "files" : "photos")
              }
            >
              <View
                accessible
                accessibilityRole="button"
                accessibilityLabel="Add a file"
                className={cn(
                  "size-8 items-center justify-center rounded-full",
                  disabled && "opacity-40",
                )}
              >
                <Icon icon={IconPlus} size={20} />
              </View>
            </MenuView>
          ) : null}
        </View>
        <View className="flex-row items-center gap-1">
          {models ? (
            <MenuView
              title="Model"
              actions={models.options.map((option) => ({
                id: option.id,
                title: option.label,
                state: option.chosen ? ("on" as const) : ("off" as const),
              }))}
              onPressAction={({ nativeEvent }) =>
                models.onPick(nativeEvent.event)
              }
            >
              <View
                accessible
                accessibilityRole="button"
                accessibilityLabel={`Model: ${models.label}. Change it`}
                className="h-8 flex-row items-center gap-1 rounded-full px-2.5"
              >
                <Text tone="muted" className="font-medium text-sm">
                  {models.label}
                </Text>
                <Icon icon={IconChevronDown} size={14} color="accent-muted" />
              </View>
            </MenuView>
          ) : null}
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
