/**
 * CopilotKit's standard catalog, as OpenBot governs it.
 *
 * A Bot composes generated interfaces from these building blocks. Each family is one row of the
 * component gallery, so an administrator publishes it, words it and withholds it per Bot like any
 * gallery component. The server builds every run's catalog from this file and from those rows; the
 * browser's own copy is used only to draw.
 *
 * A family keeps together the components that only work as a set. A Table without its rows, or a
 * TableRow on its own, is not something a Bot can draw, so they are granted as one.
 */

/** The catalog id surfaces pin to. The browser's catalog and the server's copy share it. */
export const STANDARD_UI_CATALOG_ID = "openbot/ui@1";

/** The gallery row of a family is named with this prefix, so it never meets a gallery tool name. */
export const STANDARD_UI_PREFIX = "a2ui.";

export type StandardUiGroup =
  | "layout"
  | "text"
  | "inputs"
  | "data"
  | "media"
  | "feedback"
  | "composites";

/**
 * Whether a group's families are published on arrival. Layout, text and inputs are what any
 * interface is made of; the rest wait for an administrator to switch them on.
 */
export const STANDARD_UI_GROUPS: Record<
  StandardUiGroup,
  { title: string; publishedByDefault: boolean }
> = {
  layout: { title: "Layout", publishedByDefault: true },
  text: { title: "Text", publishedByDefault: true },
  inputs: { title: "Inputs", publishedByDefault: true },
  data: { title: "Data", publishedByDefault: false },
  media: { title: "Media", publishedByDefault: false },
  feedback: { title: "Feedback and overlays", publishedByDefault: false },
  composites: { title: "Composites", publishedByDefault: false },
};

export type StandardUiFamily = {
  /** The component the family is named after. Its description is the one an administrator edits. */
  head: string;
  title: string;
  group: StandardUiGroup;
  /** Every component the family grants, the head included. */
  members: readonly string[];
};

const family = (
  group: StandardUiGroup,
  head: string,
  title: string,
  others: readonly string[] = [],
): StandardUiFamily => ({ head, title, group, members: [head, ...others] });

export const STANDARD_UI_FAMILIES: readonly StandardUiFamily[] = [
  family("layout", "Box", "Box"),
  family("layout", "Column", "Column"),
  family("layout", "Row", "Row"),
  family("layout", "Grid", "Grid", ["GridItem"]),
  family("layout", "Card", "Card"),
  family("layout", "Flow", "Flow", ["FlowItem"]),
  family("layout", "Carousel", "Carousel", [
    "CarouselItem",
    "CarouselMediaItem",
  ]),
  family("layout", "Spacer", "Spacer"),
  family("layout", "Divider", "Divider"),
  family("layout", "Tabs", "Tabs"),
  family("text", "Title", "Title"),
  family("text", "Text", "Text"),
  family("text", "Caption", "Caption"),
  family("text", "Label", "Label"),
  family("text", "Bold", "Bold"),
  family("text", "Italic", "Italic"),
  family("text", "Underline", "Underline"),
  family("text", "Strikethrough", "Strikethrough"),
  family("text", "Badge", "Badge"),
  family("text", "Blockquote", "Blockquote"),
  family("text", "Code", "Code"),
  family("text", "Markdown", "Markdown"),
  family("text", "Math", "Math"),
  family("text", "ShimmerText", "Shimmer text"),
  family("text", "Link", "Link"),
  family("text", "Tooltip", "Tooltip"),
  family("inputs", "Button", "Button"),
  family("inputs", "Pressable", "Pressable area"),
  family("inputs", "Form", "Form"),
  family("inputs", "TextField", "Text field"),
  family("inputs", "TextArea", "Text area"),
  family("inputs", "Select", "Select"),
  family("inputs", "CheckBox", "Checkbox"),
  family("inputs", "RadioGroup", "Radio group", ["Radio"]),
  family("inputs", "Slider", "Slider"),
  family("inputs", "SegmentedControl", "Segmented control"),
  family("inputs", "ChoicePicker", "Choice picker"),
  family("inputs", "DateTimeInput", "Date and time input"),
  family("data", "Table", "Table", ["TableSection", "TableRow", "TableCell"]),
  family("data", "List", "List", ["ListItem"]),
  family("data", "Chart", "Chart"),
  family("media", "Image", "Image"),
  family("media", "Icon", "Icon"),
  family("media", "Favicon", "Favicon"),
  family("media", "Svg", "SVG"),
  family("media", "Video", "Video"),
  family("media", "AudioPlayer", "Audio player"),
  family("media", "HtmlView", "HTML view"),
  family("feedback", "PulseIndicator", "Pulse indicator"),
  family("feedback", "FlashcardFlip", "Flashcard"),
  family("feedback", "Popover", "Popover", [
    "PopoverTrigger",
    "PopoverContent",
  ]),
  family("feedback", "Modal", "Modal"),
  family("composites", "LinkCard", "Link card"),
  family("composites", "Citation", "Citation"),
  family("composites", "FollowUp", "Follow-up suggestions"),
  family("composites", "EntityCard", "Entity card"),
  family("composites", "ImageGrid", "Image grid"),
];

/** The gallery row name of a family. */
export const standardUiComponentName = (family: StandardUiFamily) =>
  `${STANDARD_UI_PREFIX}${family.head}`;

export const isStandardUiComponentName = (name: string) =>
  name.startsWith(STANDARD_UI_PREFIX);

/** The family a gallery row name stands for, if it stands for one. */
export function standardUiFamily(name: string): StandardUiFamily | undefined {
  if (!isStandardUiComponentName(name)) return undefined;
  const head = name.slice(STANDARD_UI_PREFIX.length);
  return STANDARD_UI_FAMILIES.find((family) => family.head === head);
}
