type OptionCase = {
  id: string;
  request: string;
  expected: readonly string[];
  shortlist: readonly string[];
  standardExpected?: readonly string[];
};

export const cases: readonly OptionCase[] = [
  {
    id: "dropdown",
    request:
      "Let an operator pick one region from thirty choices in a dropdown that opens on click.",
    expected: ["Select"],
    shortlist: [
      "Select",
      "RadioGroup",
      "ChoicePicker",
      "SegmentedControl",
      "List",
      "TextField",
    ],
  },
  {
    id: "multiple-choice",
    request:
      "Add one field for selecting several notification channels from the available options. Store the list of selected values.",
    expected: ["ChoicePicker"],
    shortlist: [
      "ChoicePicker",
      "CheckBox",
      "Select",
      "RadioGroup",
      "SegmentedControl",
      "List",
    ],
  },
  {
    id: "boolean",
    request:
      'Put one labeled checkbox next to "Email me updates" and store its true or false value.',
    expected: ["CheckBox"],
    shortlist: [
      "CheckBox",
      "ChoicePicker",
      "Radio",
      "RadioGroup",
      "Select",
      "Button",
    ],
  },
  {
    id: "range",
    request:
      "Let a person drag a thumb along a track to set background volume from 0 to 100.",
    expected: ["Slider"],
    shortlist: [
      "Slider",
      "TextField",
      "Breakdown",
      "SegmentedControl",
      "AudioPlayer",
      "Select",
    ],
  },
  {
    id: "segmented",
    request:
      "Offer Small, Medium and Large in a single connected segmented bar. Selecting one updates a value and leaves the current panel in place.",
    expected: ["SegmentedControl"],
    shortlist: [
      "SegmentedControl",
      "Tabs",
      "RadioGroup",
      "ChoicePicker",
      "Select",
      "Row",
    ],
  },
  {
    id: "single-radio",
    request:
      "Show the three delivery methods with visible radio buttons and retain exactly one selected value. Pick the outer control to own the selection.",
    expected: ["RadioGroup"],
    shortlist: [
      "RadioGroup",
      "Radio",
      "ChoicePicker",
      "Select",
      "SegmentedControl",
      "Form",
    ],
  },
  {
    id: "multiline",
    request:
      "Add a labeled text field large enough to enter several paragraphs of incident notes and bind the typed value.",
    expected: ["TextArea", "TextField"],
    shortlist: ["TextArea", "TextField", "Markdown", "Text", "Code", "Form"],
  },
  {
    id: "schedule-time",
    request:
      "Choose a booking date and start time in 30-minute increments in one field. Keep an ISO date-time value.",
    expected: ["DateTimeInput"],
    shortlist: [
      "DateTimeInput",
      "TextField",
      "Select",
      "Form",
      "Slider",
      "Table",
    ],
  },
  {
    id: "trend",
    request:
      "Plot monthly operating costs as a line so people can see the trend. The app supplies month and cost values.",
    expected: ["Chart"],
    shortlist: ["Chart", "Table", "Svg", "Breakdown", "Grid", "Image"],
  },
  {
    id: "exact-values",
    request:
      "Compare exact unit prices, discounts and totals in aligned rows with a header and sortable-looking columns. Pick a container for tabular data with headers.",
    expected: ["Table"],
    shortlist: ["Table", "Grid", "Row", "List", "Chart", "TableSection"],
  },
  {
    id: "panel-navigation",
    request:
      "Show Overview, Specifications and Warranty as labels above three component panels. Only one panel should be visible at a time.",
    expected: ["Tabs"],
    shortlist: [
      "Tabs",
      "SegmentedControl",
      "Carousel",
      "Popover",
      "RadioGroup",
      "Column",
    ],
  },
  {
    id: "selectable-list",
    request:
      "Use one compact list of search results, each with a label, secondary value and a row action that returns its index. Choose the outer collection.",
    expected: ["List"],
    shortlist: ["List", "ListItem", "Table", "Grid", "Carousel", "Column"],
  },
  {
    id: "image-gallery",
    request:
      "Show a visual photo gallery with a large first tile and smaller tiles. Clicking a photo should open it full-screen.",
    expected: ["ImageGrid"],
    shortlist: [
      "ImageGrid",
      "Image",
      "Carousel",
      "CarouselMediaItem",
      "Grid",
      "Flow",
    ],
  },
  {
    id: "swipe-deck",
    request:
      "Put multiple content panels in a horizontally scrolling strip with arrows and snap to each page. Bind which slide is active. Choose the outer container.",
    expected: ["Carousel"],
    shortlist: [
      "Carousel",
      "CarouselItem",
      "CarouselMediaItem",
      "Tabs",
      "Row",
      "ImageGrid",
    ],
  },
  {
    id: "responsive-columns",
    request:
      "Arrange six tiles into aligned equal-width columns. Collapse to a single column on small screens and let one tile span all columns.",
    expected: ["Grid"],
    shortlist: ["Grid", "GridItem", "Flow", "Row", "Column", "Box"],
  },
  {
    id: "flashcards",
    request:
      "A study card should show a question on the front and flip to the answer when clicked or activated with the keyboard.",
    expected: ["FlashcardFlip"],
    shortlist: [
      "FlashcardFlip",
      "Card",
      "Pressable",
      "Popover",
      "Tabs",
      "Button",
    ],
  },
  {
    id: "hover-help",
    request:
      "Show one short explanatory sentence when the pointer or keyboard focus is over a status icon.",
    expected: ["Tooltip"],
    shortlist: [
      "Tooltip",
      "Popover",
      "PopoverTrigger",
      "Caption",
      "Modal",
      "Badge",
    ],
  },
  {
    id: "anchored-overlay",
    request:
      "Click a small trigger next to a field to open an anchored context panel with a button inside. Escape or clicking outside dismisses it. Choose the component containing both the trigger and panel.",
    expected: ["Popover"],
    shortlist: [
      "Popover",
      "PopoverTrigger",
      "PopoverContent",
      "Tooltip",
      "Modal",
      "Pressable",
    ],
  },
  {
    id: "modal-confirmation",
    request:
      "Open a dialog over the whole page when someone clicks Delete. It should have a backdrop, a close control and a confirmation button.",
    expected: ["Modal"],
    shortlist: ["Modal", "Popover", "Card", "Tooltip", "Button", "Form"],
  },
  {
    id: "submit-fields",
    request:
      "Collect an email and a note, then submit both fields with Enter or a submit button. Pick the container that dispatches the submit event.",
    expected: ["Form"],
    shortlist: ["Form", "Button", "Pressable", "Card", "Column", "TextField"],
  },
  {
    id: "product-card",
    request:
      "Choose a ready-made listing tile with product photo, title, price, rating and two actions built in.",
    expected: ["EntityCard"],
    shortlist: [
      "EntityCard",
      "Card",
      "ListItem",
      "ImageGrid",
      "Table",
      "Pressable",
    ],
  },
  {
    id: "clickable-group",
    request:
      "Make a whole group clickable and keyboard-activatable while letting a nested button send its own separate event. Choose the outer wrapper.",
    expected: ["Pressable"],
    shortlist: ["Pressable", "Button", "Card", "EntityCard", "Link", "Box"],
  },
  {
    id: "code-sample",
    request:
      "Show the given shell snippet as a standalone monospace code block with its formatting preserved.",
    expected: ["Code", "Markdown"],
    shortlist: ["Code", "Markdown", "Text", "TextArea", "Blockquote", "Math"],
  },
  {
    id: "formula",
    request:
      "Typeset a centered mathematical integral from its TeX source as a display formula.",
    expected: ["Math"],
    shortlist: ["Math", "Code", "Markdown", "Text", "Svg", "Image"],
  },
  {
    id: "editable-budget",
    request:
      "Show a single built-in cost breakdown with editable amounts, color-coded shares in a bar and a total that updates as someone drags a slider or types.",
    expected: ["Breakdown"],
    standardExpected: [],
    shortlist: ["Breakdown", "Slider", "Chart", "Table", "Form", "TextField"],
  },
  {
    id: "map",
    request:
      "Display an interactive street map with pan and zoom and location markers for the city’s bike stations. A static graphic or list is insufficient.",
    expected: [],
    standardExpected: ["Map"],
    shortlist: ["Image", "Svg", "Grid", "List", "Chart", "ImageGrid"],
  },
  {
    id: "file-upload",
    request:
      "Provide a native dropzone with file picking, drag and drop, and an upload progress indicator for each file. Pick the component that implements the file picker and upload behavior.",
    expected: [],
    shortlist: [
      "Form",
      "Pressable",
      "Button",
      "TextField",
      "PulseIndicator",
      "List",
    ],
  },
  {
    id: "sortable-drag",
    request:
      "Reorder work items by dragging a handle and dropping the item between rows. Pick a native component with drag-and-drop reordering built in.",
    expected: [],
    shortlist: ["List", "Table", "Flow", "Grid", "Carousel", "Pressable"],
  },
  {
    id: "spreadsheet",
    request:
      "Pick a spreadsheet editor with a grid of independently editable cells, spreadsheet formulas and recalculation across cells.",
    expected: [],
    shortlist: ["Table", "Grid", "Form", "TextField", "Breakdown", "Chart"],
  },
];
