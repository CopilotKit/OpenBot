/**
 * One small interface per family of the standard catalog, for its preview in the component gallery.
 *
 * Written as a Bot would write it: A2UI 1.0 components, rooted at "root", with data bound by
 * `{ "@path" }`. app/tests/building-block-samples.test.tsx draws every one through the SDK and fails
 * on any it rejects, so a sample cannot drift from the catalog unnoticed.
 */

type Node = { id: string; component: string } & Record<string, unknown>;
export type BuildingBlockSample = {
  components: Node[];
  dataModel?: Record<string, unknown>;
};

/** A picture with no network behind it: a soft gradient, as an SVG data URL. */
const picture = (from: string, to: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="320" height="200" fill="url(#g)"/></svg>`,
  )}`;
const PICTURES = [
  picture("#6366f1", "#0ea5e9"),
  picture("#10b981", "#f59e0b"),
  picture("#ec4899", "#8b5cf6"),
];

const text = (id: string, value: string, extra = {}): Node => ({
  id,
  component: "Text",
  text: value,
  ...extra,
});

const CITIES = ["Kyoto", "Osaka", "Nara"];

/** A container of the given kind holding three cities, each in a `cell` when one is given. */
const holding = (component: string, cell?: string): BuildingBlockSample => ({
  components: [
    {
      id: "root",
      component,
      gap: 2,
      children: CITIES.map((_, index) => `c${index}`),
    },
    ...CITIES.flatMap((city, index) =>
      cell
        ? [
            { id: `c${index}`, component: cell, children: [`t${index}`] },
            text(`t${index}`, city),
          ]
        : [text(`c${index}`, city)],
    ),
  ],
});

/** A component on its own, under the root. */
const alone = (
  node: Omit<Node, "id">,
  dataModel?: Record<string, unknown>,
) => ({
  components: [{ id: "root", ...node } as Node],
  ...(dataModel ? { dataModel } : {}),
});

export const BUILDING_BLOCK_SAMPLES: Record<string, BuildingBlockSample> = {
  Box: {
    components: [
      {
        id: "root",
        component: "Box",
        padding: 4,
        border: true,
        radius: "lg",
        background: "surface-secondary",
        children: ["inside"],
      },
      text("inside", "Grouped with padding, a border and a background"),
    ],
  },
  Column: holding("Column"),
  Row: holding("Row"),
  Grid: holding("Grid", "GridItem"),
  Card: {
    components: [
      { id: "root", component: "Card", children: ["title", "body"] },
      { id: "title", component: "Title", text: "Trip to Kyoto" },
      text("body", "Three nights in April, two travellers."),
    ],
  },
  Flow: holding("Flow", "FlowItem"),
  Carousel: {
    components: [
      {
        id: "root",
        component: "Carousel",
        children: CITIES.map((_, index) => `c${index}`),
      },
      ...CITIES.flatMap((city, index) => [
        {
          id: `c${index}`,
          component: "CarouselMediaItem",
          url: PICTURES[index],
          children: [`t${index}`],
        },
        { id: `t${index}`, component: "Caption", text: city },
      ]),
    ],
  },
  Spacer: {
    components: [
      { id: "root", component: "Row", children: ["left", "gap", "right"] },
      text("left", "Left"),
      { id: "gap", component: "Spacer" },
      text("right", "Right"),
    ],
  },
  Divider: {
    components: [
      { id: "root", component: "Column", children: ["above", "line", "below"] },
      text("above", "Above the line"),
      { id: "line", component: "Divider" },
      text("below", "Below the line"),
    ],
  },
  Tabs: {
    components: [
      {
        id: "root",
        component: "Tabs",
        tabs: [
          { title: "Itinerary", child: "one" },
          { title: "Budget", child: "two" },
        ],
      },
      text("one", "Day 1: Fushimi Inari. Day 2: Arashiyama."),
      text("two", "About ¥120,000 for two."),
    ],
  },
  Title: alone({ component: "Title", text: "Plan a trip" }),
  Text: alone({
    component: "Text",
    text: "Kyoto is quieter in early April, before the cherry blossom peaks.",
  }),
  Caption: alone({
    component: "Caption",
    text: "Prices are for two travellers.",
  }),
  Label: alone({ component: "Label", text: "Destination" }),
  Bold: alone({ component: "Bold", text: "Booked" }),
  Italic: alone({ component: "Italic", text: "Subject to availability" }),
  Underline: alone({ component: "Underline", text: "Read before booking" }),
  Strikethrough: alone({ component: "Strikethrough", text: "¥150,000" }),
  Badge: {
    components: [
      { id: "root", component: "Row", gap: 2, children: ["a", "b", "c"] },
      { id: "a", component: "Badge", label: "Confirmed", color: "success" },
      { id: "b", component: "Badge", label: "Pending", color: "warning" },
      { id: "c", component: "Badge", label: "Draft" },
    ],
  },
  Blockquote: alone({
    component: "Blockquote",
    text: "The best time to visit is the week before the blossoms.",
  }),
  Code: alone({
    component: "Code",
    text: "KIX → Kyoto: 75 min",
    language: "text",
  }),
  Markdown: alone({
    component: "Markdown",
    text: "**Day 1.** Fushimi Inari at dawn.\n\n- Bring cash\n- Wear good shoes",
  }),
  Math: alone({
    component: "Math",
    value: "\\text{total} = 2 \\times 60{,}000",
  }),
  ShimmerText: alone({ component: "ShimmerText", text: "Finding trains…" }),
  Link: alone({
    component: "Link",
    text: "Kyoto city guide",
    href: "https://example.com/kyoto",
  }),
  Tooltip: {
    components: [
      { id: "root", component: "Tooltip", trigger: "badge", content: "tip" },
      { id: "badge", component: "Badge", label: "JR Pass" },
      text("tip", "Covers most trains in the city."),
    ],
  },
  Button: {
    components: [
      { id: "root", component: "Row", gap: 2, children: ["primary", "other"] },
      { id: "primary", component: "Button", label: "Book", variant: "primary" },
      { id: "other", component: "Button", label: "Later" },
    ],
  },
  Pressable: {
    components: [
      {
        id: "root",
        component: "Pressable",
        padding: 3,
        border: true,
        radius: "md",
        children: ["label"],
      },
      text("label", "Open the itinerary"),
    ],
  },
  Form: {
    components: [
      { id: "root", component: "Form", gap: 3, children: ["field", "send"] },
      {
        id: "field",
        component: "TextField",
        label: "Destination",
        value: { "@path": "/destination" },
      },
      { id: "send", component: "Button", label: "Plan trip", submit: true },
    ],
    dataModel: { destination: "Kyoto" },
  },
  TextField: alone(
    {
      component: "TextField",
      label: "Destination",
      placeholder: "City, region, or country",
      value: { "@path": "/destination" },
    },
    { destination: "Kyoto" },
  ),
  TextArea: alone(
    {
      component: "TextArea",
      label: "Notes",
      value: { "@path": "/notes" },
      rows: 3,
    },
    { notes: "Vegetarian meals, please." },
  ),
  Select: alone(
    {
      component: "Select",
      label: "Season",
      options: ["Spring", "Summer", "Autumn", "Winter"],
      value: { "@path": "/season" },
    },
    { season: "Spring" },
  ),
  CheckBox: alone(
    {
      component: "CheckBox",
      label: "Add travel insurance",
      value: { "@path": "/insured" },
    },
    { insured: true },
  ),
  RadioGroup: alone(
    {
      component: "RadioGroup",
      label: "Pace",
      options: ["Relaxed", "Balanced", "Full days"],
      value: { "@path": "/pace" },
    },
    { pace: "Balanced" },
  ),
  Slider: alone(
    {
      component: "Slider",
      label: "Travellers",
      min: 1,
      max: 8,
      value: { "@path": "/travellers" },
    },
    { travellers: 2 },
  ),
  SegmentedControl: alone(
    {
      component: "SegmentedControl",
      options: ["Train", "Bus", "Taxi"],
      value: { "@path": "/mode" },
    },
    { mode: "Train" },
  ),
  ChoicePicker: alone(
    {
      component: "ChoicePicker",
      label: "Interests",
      options: ["Temples", "Food", "Gardens", "Shopping"],
      value: { "@path": "/interests" },
    },
    { interests: ["Temples", "Food"] },
  ),
  DateTimeInput: alone(
    {
      component: "DateTimeInput",
      label: "Arrival",
      value: { "@path": "/arrival" },
    },
    { arrival: "2026-04-02" },
  ),
  Table: alone({
    component: "Table",
    columns: ["City", { label: "Nights", align: "end" }],
    rows: [
      ["Kyoto", "3"],
      ["Osaka", "2"],
      ["Nara", "1"],
    ],
  }),
  List: alone({
    component: "List",
    items: [
      { label: "Fushimi Inari", value: "Day 1" },
      { label: "Arashiyama", value: "Day 2" },
      { label: "Nara Park", value: "Day 3" },
    ],
  }),
  Chart: alone({
    component: "Chart",
    chartType: "bar",
    xKey: "city",
    series: [{ key: "nights", label: "Nights" }],
    data: [
      { city: "Kyoto", nights: 3 },
      { city: "Osaka", nights: 2 },
      { city: "Nara", nights: 1 },
    ],
  }),
  Image: alone({
    component: "Image",
    url: PICTURES[0],
    description: "A gradient",
    aspectRatio: "16/9",
  }),
  Icon: {
    components: [
      { id: "root", component: "Row", gap: 3, children: ["a", "b", "c"] },
      { id: "a", component: "Icon", name: "calendar" },
      { id: "b", component: "Icon", name: "map-pin" },
      { id: "c", component: "Icon", name: "train" },
    ],
  },
  // Drawn from Google's favicon service, as it is in a conversation.
  Favicon: {
    components: [
      { id: "root", component: "Row", gap: 2, children: ["icon", "site"] },
      { id: "icon", component: "Favicon", url: "https://www.copilotkit.ai" },
      text("site", "copilotkit.ai"),
    ],
  },
  Svg: alone({
    component: "Svg",
    viewBox: "0 0 24 24",
    size: 48,
    label: "A check mark",
    paths: [{ d: "M5 12l5 5L20 7", stroke: "currentColor", strokeWidth: 2 }],
  }),
  Video: alone({
    component: "Video",
    url: "about:blank",
    posterUrl: PICTURES[2],
    title: "A walk through Gion",
  }),
  AudioPlayer: alone({
    component: "AudioPlayer",
    url: "about:blank",
    description: "Station announcements",
  }),
  HtmlView: alone({
    component: "HtmlView",
    title: "Timetable",
    html: "<p style='font-family:sans-serif'>Next train: <b>09:12</b></p>",
    height: 80,
  }),
  PulseIndicator: alone({ component: "PulseIndicator", label: "Booking" }),
  FlashcardFlip: alone({
    component: "FlashcardFlip",
    front: "Thank you",
    back: "Arigatō",
    hint: "Click to flip",
  }),
  Popover: {
    components: [
      { id: "root", component: "Popover", children: ["trigger", "body"] },
      { id: "trigger", component: "PopoverTrigger", children: ["label"] },
      text("label", "What is included?"),
      { id: "body", component: "PopoverContent", children: ["details"] },
      text("details", "Hotel, breakfast and rail passes."),
    ],
  },
  Modal: {
    components: [
      {
        id: "root",
        component: "Modal",
        title: "Booking details",
        trigger: "open",
        content: "body",
      },
      { id: "open", component: "Button", label: "See details" },
      text("body", "Three nights at a ryokan in Gion."),
    ],
  },
  LinkCard: alone({
    component: "LinkCard",
    href: "https://example.com/kyoto",
    title: "Kyoto in spring",
    description: "Where to go before the crowds.",
    domain: "example.com",
  }),
  Citation: alone({
    component: "Citation",
    index: 1,
    title: "Kyoto city guide",
    url: "https://example.com/kyoto",
    source: "example.com",
  }),
  FollowUp: alone({
    component: "FollowUp",
    items: ["Add a day in Nara", "Find a ryokan", "Compare rail passes"],
  }),
  EntityCard: alone({
    component: "EntityCard",
    title: "Ryokan Gion",
    subtitle: "Kyoto",
    description: "Traditional inn, ten minutes from Yasaka Shrine.",
    image: PICTURES[0],
    badge: { label: "Available", color: "success" },
    meta: "¥40,000 a night",
  }),
  ImageGrid: alone({
    component: "ImageGrid",
    images: PICTURES.map((url, index) => ({
      url,
      caption: CITIES[index],
    })),
  }),
};
