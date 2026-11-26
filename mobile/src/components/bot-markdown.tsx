import { Linking } from "react-native";
import {
  EnrichedMarkdownText,
  type MarkdownImageOccurrence,
  type MarkdownStyle,
} from "react-native-enriched-markdown";
import { useUniwind } from "uniwind";
import { scheme } from "../scheme";
import { webLink } from "../web-link";

function messageStyle(theme: keyof typeof scheme): MarkdownStyle {
  const colors = scheme[theme];
  const color = colors.foreground;
  const muted = colors["muted-foreground"];
  const borderColor = colors.border;
  const body = { color, fontFamily: "Inter_400Regular", lineHeight: 24 };
  const heading = {
    color,
    fontFamily: "Inter_600SemiBold",
    fontWeight: "normal",
  };
  return {
    paragraph: body,
    h1: heading,
    h2: heading,
    h3: heading,
    h4: heading,
    h5: heading,
    h6: heading,
    strong: { fontFamily: "Inter_700Bold", fontWeight: "normal" },
    link: { color, underline: true },
    list: { ...body, bulletColor: muted, markerColor: muted, marginLeft: 4 },
    blockquote: { ...body, borderColor, backgroundColor: colors.muted },
    code: { color, backgroundColor: colors.muted, borderColor },
    codeBlock: {
      color,
      backgroundColor: colors.muted,
      borderColor,
      syntaxColors: {
        keyword: colors.destructive,
        string: colors.success,
        number: color,
        constant: color,
        comment: muted,
        function: color,
        type: color,
        property: color,
        tag: colors.success,
        attribute: color,
      },
    },
    table: {
      ...body,
      headerFontFamily: heading.fontFamily,
      headerTextColor: color,
      headerBackgroundColor: colors.muted,
      rowEvenBackgroundColor: colors.card,
      rowOddBackgroundColor: colors.card,
      borderColor,
    },
    taskList: {
      checkedColor: color,
      checkmarkColor: colors["primary-foreground"],
      borderColor: muted,
      checkedTextColor: color,
    },
    thematicBreak: { color: borderColor },
    math: { color, backgroundColor: colors.muted },
    inlineMath: { color },
  };
}

const styles = { light: messageStyle("light"), dark: messageStyle("dark") };
const markdownFlags = { hardSoftBreaks: true };

function openLink({ url }: { url: string }) {
  const link = webLink(url);
  if (link) void Linking.openURL(link.href).catch(() => {});
}

function resolveImage({ url }: MarkdownImageOccurrence) {
  return { uri: webLink(url)?.href ?? "" };
}

export function BotMarkdown({ text }: { text: string }) {
  const { theme } = useUniwind();
  return (
    <EnrichedMarkdownText
      markdown={text}
      flavor="github"
      md4cFlags={markdownFlags}
      markdownStyle={styles[theme === "dark" ? "dark" : "light"]}
      selectable
      allowFontScaling
      enableTaskListItemToggle={false}
      enableLinkPreview={false}
      onLinkPress={openLink}
      resolveImageSource={resolveImage}
    />
  );
}
