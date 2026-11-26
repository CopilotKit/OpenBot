import * as WebBrowser from "expo-web-browser";
import { Fragment, useMemo } from "react";
import {
  Linking,
  Text as NativeText,
  Platform,
  ScrollView,
  View,
} from "react-native";
import { IconSquare, IconSquareCheck } from "../icons";
import {
  type Block,
  type ListItem,
  parseMarkdown,
  plainText,
  type Span,
} from "../markdown";
import { cn } from "./cn";
import { Icon } from "./icon";
import { Text } from "./text";

/** Code in the platform's own fixed-width face: the app loads Inter only. */
const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

/** A web link opens in the browser sheet over the app, as the platform's own apps open one; mail in the mail app. */
function open(href: string) {
  if (href.startsWith("mailto:")) void Linking.openURL(href);
  else
    void WebBrowser.openBrowserAsync(href).catch(() => Linking.openURL(href));
}

/**
 * A Bot's reply drawn from its Markdown, as the web app draws it: headings, lists, quotes, code and
 * links in the app's own type, with no color but the text's. What isn't Markdown reads as written.
 */
export function Markdown({ text }: { text: string }) {
  // Read once for each reply, not again on each keystroke in the message box under it.
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View className="gap-3">
      {blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one reply, in its order
        <BlockView key={index} block={block} />
      ))}
    </View>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading":
      return (
        <Text
          variant={block.level <= 2 ? "heading" : "label"}
          selectable
          className={cn(block.level <= 2 ? "pt-1" : "font-semibold")}
        >
          <Spans spans={block.spans} />
        </Text>
      );
    case "paragraph":
      return (
        <Text selectable>
          <Spans spans={block.spans} />
        </Text>
      );
    case "list":
      return (
        <View className="gap-1.5">
          {block.items.map((item, index) => (
            <ListRow
              // biome-ignore lint/suspicious/noArrayIndexKey: the items of one list, in its order
              key={index}
              item={item}
              marker={block.ordered ? `${block.start + index}.` : "•"}
              wide={block.ordered && block.start + block.items.length > 10}
            />
          ))}
        </View>
      );
    case "quote":
      return (
        <View className="gap-3 border-l-2 border-border pl-3">
          {block.blocks.map((inner, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one quote, in its order
            <BlockView key={index} block={inner} />
          ))}
        </View>
      );
    case "code":
      return (
        <View className="overflow-hidden rounded-lg border border-border bg-fill">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="px-3 py-2.5"
          >
            <NativeText
              selectable
              accessibilityLabel={block.text}
              style={{ fontFamily: MONO }}
              className="text-sm leading-5 text-foreground"
            >
              {block.text}
            </NativeText>
          </ScrollView>
        </View>
      );
    case "rule":
      return <View className="my-1 h-px bg-border" />;
  }
}

function ListRow({
  item,
  marker,
  wide,
}: {
  item: ListItem;
  marker: string;
  wide: boolean;
}) {
  return (
    <View className="flex-row gap-2">
      <View className={cn("items-end pt-0.5", wide ? "w-7" : "w-5")}>
        {item.checked === undefined ? (
          <Text tone="muted" className="leading-6">
            {marker}
          </Text>
        ) : (
          <View className="pt-0.5">
            <Icon
              icon={item.checked ? IconSquareCheck : IconSquare}
              size={18}
              color="accent-muted"
            />
          </View>
        )}
      </View>
      <Text
        selectable
        className={cn("flex-1", item.checked && "text-muted line-through")}
        accessibilityLabel={
          item.checked === undefined
            ? undefined
            : `${item.checked ? "Done" : "Not done"}: ${plainText(item.spans)}`
        }
      >
        <Spans spans={item.spans} />
      </Text>
    </View>
  );
}

/**
 * Spans inside a line. They are nested text, so they keep the line's size and color; each sets only
 * what it changes. Inter's weights are faces of their own, so bold is a face, not a weight.
 */
function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the spans of one line, in its order
        <Fragment key={index}>{renderSpan(span)}</Fragment>
      ))}
    </>
  );
}

function renderSpan(span: Span) {
  switch (span.kind) {
    case "text":
      return span.text;
    case "bold":
      return (
        <NativeText className="font-semibold">
          <Spans spans={span.children} />
        </NativeText>
      );
    case "italic":
      return (
        <NativeText className="font-italic">
          <Spans spans={span.children} />
        </NativeText>
      );
    case "strike":
      return (
        <NativeText className="line-through">
          <Spans spans={span.children} />
        </NativeText>
      );
    case "code":
      return (
        <NativeText
          style={{ fontFamily: MONO }}
          className="bg-fill text-sm text-foreground"
        >
          {` ${span.text} `}
        </NativeText>
      );
    case "link":
      return (
        <NativeText
          accessibilityRole="link"
          onPress={() => open(span.href)}
          className="underline"
        >
          <Spans spans={span.children} />
        </NativeText>
      );
  }
}
