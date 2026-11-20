/*
 * Every icon OpenBot draws, from Hugeicons' free set (MIT), the family Figma's master screens are
 * drawn with.
 *
 * Each export is named for what it shows, under the names the app used when it drew Tabler's icons,
 * so a screen imports `IconPlus` from here and never names an icon set. Changing a glyph, or the
 * whole family (Hugeicons Pro has the solid and duotone styles the free set lacks), is a change to
 * this file alone.
 *
 * The free set has one style, Stroke Rounded, at Hugeicons' 1.5 stroke on a 24-unit grid. Tabler's
 * filled variants are the same outline filled in, which is what they marked: a pinned pin, an open
 * folder, a recording dot.
 */
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  type ForwardRefExoticComponent,
  forwardRef,
  type RefAttributes,
  type SVGProps,
} from "react";

import { cn } from "@/lib/utils";

export type { IconSvgElement };

export type IconProps = Omit<
  SVGProps<SVGSVGElement>,
  "ref" | "stroke" | "strokeWidth"
> & {
  /** Width and height, 24 by default. A `size-*` class wins over it, as it did over Tabler's. */
  size?: number | string;
  /** Stroke width on the icon's 24-unit grid, under Tabler's name for it. Hugeicons' 1.5 by default. */
  stroke?: number | string;
};

export type Icon = ForwardRefExoticComponent<
  IconProps & RefAttributes<SVGSVGElement>
>;

/**
 * The set's line, for a glyph of OpenBot's own: spread into each of its elements, which is where
 * the set's glyphs carry theirs, so it draws at the same weight beside them.
 */
export const GLYPH_STROKE = {
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: "1.5",
} as const;

/**
 * An icon from a Hugeicons glyph, or from a glyph of OpenBot's own drawn on the same grid.
 *
 * `name` becomes the `icon-<name>` class, which says which glyph a test is looking at without
 * naming the set it comes from.
 */
export function defineIcon(
  name: string,
  glyph: IconSvgElement,
  { filled = false }: { filled?: boolean } = {},
): Icon {
  const Component = forwardRef<SVGSVGElement, IconProps>(
    ({ className, stroke, ...props }, ref) => (
      <HugeiconsIcon
        ref={ref}
        icon={glyph}
        className={cn("icon", `icon-${name}`, className)}
        // Left out rather than undefined: an undefined `fill` would replace the set's `none`.
        {...(filled ? { fill: "currentColor" } : {})}
        {...(stroke === undefined ? {} : { strokeWidth: Number(stroke) })}
        {...props}
      />
    ),
  );
  Component.displayName = `Icon(${name})`;
  return Component;
}

import {
  AiBrain01Icon,
  Alert02Icon,
  AlertDiamondIcon,
  ArrowDataTransferHorizontalIcon,
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowExpandIcon,
  ArrowLeft01Icon,
  ArrowLeft02Icon,
  ArrowMoveDownRightIcon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  ArrowUpDownIcon,
  ArrowUpRight01Icon,
  BankIcon,
  BookOpen01Icon,
  BotIcon,
  BrowserIcon,
  BubbleChatIcon,
  Bug01Icon,
  Building03Icon,
  BulbIcon,
  Calendar03Icon,
  CalendarSyncIcon,
  Camera01Icon,
  Cancel01Icon,
  ChartHistogramIcon,
  CheckListIcon,
  CheckmarkBadge01Icon,
  CheckmarkCircle02Icon,
  CheckmarkSquare02Icon,
  CircleDashedIcon,
  Clock01Icon,
  Clock03Icon,
  CloudIcon,
  CloudOffIcon,
  ComputerIcon,
  ComputerPhoneSyncIcon,
  ComputerRemoveIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  CpuIcon,
  CreditCardIcon,
  Csv01Icon,
  CubeIcon,
  Cursor01Icon,
  DashboardSpeed01Icon,
  DashboardSquare01Icon,
  DashboardSquareRemoveIcon,
  Database01Icon,
  Delete02Icon,
  Doc01Icon,
  Download01Icon,
  Eraser01Icon,
  File01Icon,
  File02Icon,
  FileAddIcon,
  FileBracesIcon,
  FileRemoveIcon,
  FileScriptIcon,
  FileValidationIcon,
  FilterIcon,
  FingerPrintIcon,
  Flag01Icon,
  FloppyDiskIcon,
  Folder01Icon,
  FolderSearchIcon,
  GithubIcon,
  Globe02Icon,
  GlobeOffIcon,
  GoogleDriveIcon,
  GoogleIcon,
  GridViewIcon,
  HandIcon,
  HelpCircleIcon,
  HierarchyIcon,
  HierarchySquare02Icon,
  HistoryIcon,
  Home01Icon,
  IdIcon,
  Image01Icon,
  InboxIcon,
  InformationCircleIcon,
  Key01Icon,
  KeyboardIcon,
  LaptopIcon,
  Layers01Icon,
  LeftToRightListBulletIcon,
  LifebuoyIcon,
  Link01Icon,
  LinkSquare02Icon,
  Loading03Icon,
  LockIcon,
  LockPasswordIcon,
  Login01Icon,
  Logout01Icon,
  Mail01Icon,
  MailAdd01Icon,
  MailRemove01Icon,
  Megaphone01Icon,
  Menu01Icon,
  Menu02Icon,
  Message01Icon,
  Message02Icon,
  MessageBlockedIcon,
  MessageNotification01Icon,
  MessageQuestionIcon,
  Mic01Icon,
  MicOff01Icon,
  MicrosoftTeamsIcon,
  MinusSignCircleIcon,
  MinusSignIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  Mortarboard02Icon,
  NetworkIcon,
  Note01Icon,
  Notification01Icon,
  Notification03Icon,
  Notion01Icon,
  PackageIcon,
  PaintBoardIcon,
  PauseIcon,
  Pdf01Icon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  Plug02Icon,
  PlugSocketIcon,
  PlusSignCircleIcon,
  PlusSignIcon,
  Ppt01Icon,
  PresentationBarChart01Icon,
  Progress01Icon,
  PuzzleIcon,
  Radar01Icon,
  RecordIcon,
  RefreshIcon,
  ReloadIcon,
  RepeatIcon,
  Robot01Icon,
  Route01Icon,
  Search01Icon,
  SearchList01Icon,
  SearchList02Icon,
  SecurityBlockIcon,
  SecurityCheckIcon,
  SecurityLockIcon,
  SentIcon,
  ServerStack01Icon,
  Settings01Icon,
  ShapesIcon,
  Share08Icon,
  SidebarLeftIcon,
  SlackIcon,
  SlidersHorizontalIcon,
  SmartPhone01Icon,
  SourceCodeIcon,
  SparklesIcon,
  SquareUnlock02Icon,
  StarIcon,
  StopIcon,
  SunMoonIcon,
  Table01Icon,
  Tag01Icon,
  Target01Icon,
  Target02Icon,
  TeacherIcon,
  TextIcon,
  Tick02Icon,
  TickDouble02Icon,
  TimeScheduleIcon,
  ToggleOnIcon,
  UnavailableIcon,
  UnfoldMoreIcon,
  UserCheck01Icon,
  UserCircleIcon,
  UserGroupIcon,
  UserIcon,
  UserMultipleIcon,
  UserSettings01Icon,
  UserShield01Icon,
  Video01Icon,
  ViewIcon,
  ViewOffSlashIcon,
  WebhookIcon,
  WindowsNewIcon,
  Wrench01Icon,
  Xls01Icon,
} from "@hugeicons/core-free-icons";

export const IconAdjustments = defineIcon("adjustments", SlidersHorizontalIcon);
export const IconAlertOctagon = defineIcon("alert-octagon", AlertDiamondIcon);
export const IconAlertTriangle = defineIcon("alert-triangle", Alert02Icon);
export const IconApps = defineIcon("apps", DashboardSquare01Icon);
export const IconAppsOff = defineIcon("apps-off", DashboardSquareRemoveIcon);
export const IconArrowDown = defineIcon("arrow-down", ArrowDown02Icon);
export const IconArrowLeft = defineIcon("arrow-left", ArrowLeft02Icon);
export const IconArrowRight = defineIcon("arrow-right", ArrowRight02Icon);
export const IconArrowUp = defineIcon("arrow-up", ArrowUp02Icon);
export const IconArrowUpRight = defineIcon(
  "arrow-up-right",
  ArrowUpRight01Icon,
);
export const IconArrowsExchange = defineIcon(
  "arrows-exchange",
  ArrowDataTransferHorizontalIcon,
);
export const IconArrowsMaximize = defineIcon(
  "arrows-maximize",
  ArrowExpandIcon,
);
export const IconArrowsVertical = defineIcon(
  "arrows-vertical",
  ArrowUpDownIcon,
);
export const IconBan = defineIcon("ban", UnavailableIcon);
export const IconBell = defineIcon("bell", Notification01Icon);
export const IconBellRinging = defineIcon("bell-ringing", Notification03Icon);
/*
 * Bots and Connections are Figma's own drawings rather than the set's ("Master screens" navigation):
 * Figma's 18px frames scaled onto the 24-unit grid, drawn with the set's line.
 */
export const IconBolt = defineIcon("bolt", [
  [
    "path",
    {
      d: "M8.169 12.674H8.628C9.859 12.674 10.474 12.674 10.795 13.076C11.116 13.478 10.983 14.082 10.716 15.29L10.029 18.396C9.678 19.982 9.503 20.775 9.868 20.965C10.233 21.156 10.777 20.555 11.864 19.352L17.399 13.232C18.092 12.466 18.438 12.083 18.487 11.763C18.551 11.348 18.369 10.934 18.02 10.702C17.752 10.524 17.237 10.524 16.207 10.524C15.393 10.524 14.985 10.524 14.735 10.377C14.41 10.186 14.209 9.838 14.206 9.46C14.203 9.168 14.405 8.813 14.809 8.102L15.881 6.216C16.694 4.786 17.101 4.071 16.792 3.535C16.482 3 15.663 3 14.024 3H11.935C10.586 3 9.911 3 9.38 3.347C8.848 3.694 8.574 4.314 8.027 5.553L6.215 9.651C5.612 11.014 5.311 11.695 5.627 12.184C5.943 12.674 6.685 12.674 8.169 12.674Z",
      key: "bolt",
      ...GLYPH_STROKE,
    },
  ],
]);
export const IconBook = defineIcon("book", BookOpen01Icon);
export const IconBox = defineIcon("box", PackageIcon);
export const IconBrain = defineIcon("brain", AiBrain01Icon);
export const IconBrandGithub = defineIcon("brand-github", GithubIcon);
export const IconBrandGoogle = defineIcon("brand-google", GoogleIcon);
export const IconBrandGoogleDrive = defineIcon(
  "brand-google-drive",
  GoogleDriveIcon,
);
export const IconBrandNotion = defineIcon("brand-notion", Notion01Icon);
export const IconBrandSlack = defineIcon("brand-slack", SlackIcon);
export const IconBrandTeams = defineIcon("brand-teams", MicrosoftTeamsIcon);
export const IconBrandWindows = defineIcon("brand-windows", WindowsNewIcon);
export const IconBrowser = defineIcon("browser", BrowserIcon);
export const IconBug = defineIcon("bug", Bug01Icon);
export const IconBuilding = defineIcon("building", Building03Icon);
export const IconBuildingBank = defineIcon("building-bank", BankIcon);
export const IconBulb = defineIcon("bulb", BulbIcon);
export const IconCalendarRepeat = defineIcon(
  "calendar-repeat",
  CalendarSyncIcon,
);
export const IconCalendarTime = defineIcon("calendar-time", Calendar03Icon);
export const IconCamera = defineIcon("camera", Camera01Icon);
export const IconChalkboardTeacher = defineIcon(
  "chalkboard-teacher",
  TeacherIcon,
);
export const IconChartBar = defineIcon("chart-bar", ChartHistogramIcon);
export const IconCheck = defineIcon("check", Tick02Icon);
export const IconChecklist = defineIcon("checklist", CheckListIcon);
export const IconChecks = defineIcon("checks", TickDouble02Icon);
export const IconChevronDown = defineIcon("chevron-down", ArrowDown01Icon);
export const IconChevronLeft = defineIcon("chevron-left", ArrowLeft01Icon);
export const IconChevronRight = defineIcon("chevron-right", ArrowRight01Icon);
export const IconChevronUp = defineIcon("chevron-up", ArrowUp01Icon);
export const IconCircleCheck = defineIcon(
  "circle-check",
  CheckmarkCircle02Icon,
);
export const IconCircleDashed = defineIcon("circle-dashed", CircleDashedIcon);
export const IconCircleMinus = defineIcon("circle-minus", MinusSignCircleIcon);
export const IconCirclePlus = defineIcon("circle-plus", PlusSignCircleIcon);
export const IconClock = defineIcon("clock", Clock01Icon);
export const IconClockHour3 = defineIcon("clock-hour-3", Clock03Icon);
export const IconClockPlay = defineIcon("clock-play", TimeScheduleIcon);
export const IconCloud = defineIcon("cloud", CloudIcon);
export const IconCloudOff = defineIcon("cloud-off", CloudOffIcon);
export const IconCode = defineIcon("code", SourceCodeIcon);
export const IconCopy = defineIcon("copy", Copy01Icon);
export const IconCornerDownRight = defineIcon(
  "corner-down-right",
  ArrowMoveDownRightIcon,
);
export const IconCpu = defineIcon("cpu", CpuIcon);
export const IconCreditCard = defineIcon("credit-card", CreditCardIcon);
export const IconCube = defineIcon("cube", CubeIcon);
export const IconDatabase = defineIcon("database", Database01Icon);
export const IconDeviceDesktop = defineIcon("device-desktop", ComputerIcon);
export const IconDeviceDesktopOff = defineIcon(
  "device-desktop-off",
  ComputerRemoveIcon,
);
export const IconDeviceFloppy = defineIcon("device-floppy", FloppyDiskIcon);
export const IconDeviceLaptop = defineIcon("device-laptop", LaptopIcon);
export const IconDeviceMobile = defineIcon("device-mobile", SmartPhone01Icon);
export const IconDeviceMobileMessage = defineIcon(
  "device-mobile-message",
  MessageNotification01Icon,
);
export const IconDevices = defineIcon("devices", ComputerPhoneSyncIcon);
export const IconDots = defineIcon("dots", MoreHorizontalIcon);
export const IconDownload = defineIcon("download", Download01Icon);
export const IconEraser = defineIcon("eraser", Eraser01Icon);
export const IconExternalLink = defineIcon("external-link", LinkSquare02Icon);
export const IconEye = defineIcon("eye", ViewIcon);
export const IconEyeCheck = defineIcon("eye-check", CheckmarkBadge01Icon);
export const IconEyeOff = defineIcon("eye-off", ViewOffSlashIcon);
export const IconFile = defineIcon("file", File01Icon);
export const IconFileCheck = defineIcon("file-check", FileValidationIcon);
export const IconFileOff = defineIcon("file-off", FileRemoveIcon);
export const IconFilePlus = defineIcon("file-plus", FileAddIcon);
export const IconFileText = defineIcon("file-text", File02Icon);
export const IconFileTypeCsv = defineIcon("file-type-csv", Csv01Icon);
export const IconFileTypeDocx = defineIcon("file-type-docx", Doc01Icon);
export const IconFileTypePdf = defineIcon("file-type-pdf", Pdf01Icon);
export const IconFileTypePpt = defineIcon("file-type-ppt", Ppt01Icon);
export const IconFileTypeXls = defineIcon("file-type-xls", Xls01Icon);
export const IconFilter = defineIcon("filter", FilterIcon);
export const IconFingerprint = defineIcon("fingerprint", FingerPrintIcon);
export const IconFlag = defineIcon("flag", Flag01Icon);
export const IconFolder = defineIcon("folder", Folder01Icon);
export const IconFolderFilled = defineIcon("folder-filled", Folder01Icon, {
  filled: true,
});
export const IconFolderSearch = defineIcon("folder-search", FolderSearchIcon);
export const IconGauge = defineIcon("gauge", DashboardSpeed01Icon);
export const IconHandStop = defineIcon("hand-stop", HandIcon);
export const IconHelpCircle = defineIcon("help-circle", HelpCircleIcon);
export const IconHistory = defineIcon("history", HistoryIcon);
export const IconHome = defineIcon("home", Home01Icon);
export const IconId = defineIcon("id", IdIcon);
export const IconInbox = defineIcon("inbox", InboxIcon);
export const IconInfoCircle = defineIcon("info-circle", InformationCircleIcon);
export const IconJson = defineIcon("json", FileBracesIcon);
export const IconKey = defineIcon("key", Key01Icon);
export const IconKeyboard = defineIcon("keyboard", KeyboardIcon);
export const IconLayoutGrid = defineIcon("layout-grid", GridViewIcon);
export const IconLayoutSidebar = defineIcon("layout-sidebar", SidebarLeftIcon);
export const IconLifebuoy = defineIcon("lifebuoy", LifebuoyIcon);
export const IconLink = defineIcon("link", Link01Icon);
export const IconList = defineIcon("list", Menu01Icon);
export const IconListCheck = defineIcon("list-check", CheckListIcon);
export const IconListDetails = defineIcon(
  "list-details",
  LeftToRightListBulletIcon,
);
export const IconListSearch = defineIcon("list-search", SearchList01Icon);
export const IconLoader = defineIcon("loader", Loading03Icon);
export const IconLoader2 = defineIcon("loader-2", Loading03Icon);
export const IconLock = defineIcon("lock", LockIcon);
export const IconLockAccess = defineIcon("lock-access", LockPasswordIcon);
export const IconLockOff = defineIcon("lock-off", SquareUnlock02Icon);
export const IconLogin2 = defineIcon("login-2", Login01Icon);
export const IconLogout = defineIcon("logout", Logout01Icon);
export const IconMail = defineIcon("mail", Mail01Icon);
export const IconMailOff = defineIcon("mail-off", MailRemove01Icon);
export const IconMailPlus = defineIcon("mail-plus", MailAdd01Icon);
export const IconMarkdown = defineIcon("markdown", FileScriptIcon);
export const IconMenu2 = defineIcon("menu-2", Menu02Icon);
export const IconMessage = defineIcon("message", Message01Icon);
export const IconMessageChatbot = defineIcon("message-chatbot", BotIcon);
export const IconMessageCircle = defineIcon("message-circle", BubbleChatIcon);
export const IconMessageOff = defineIcon("message-off", MessageBlockedIcon);
export const IconMessageQuestion = defineIcon(
  "message-question",
  MessageQuestionIcon,
);
export const IconMessages = defineIcon("messages", Message02Icon);
export const IconMicrophone = defineIcon("microphone", Mic01Icon);
export const IconMicrophoneOff = defineIcon("microphone-off", MicOff01Icon);
export const IconMinus = defineIcon("minus", MinusSignIcon);
export const IconMoon = defineIcon("moon", Moon02Icon);
export const IconNetwork = defineIcon("network", NetworkIcon);
export const IconNotes = defineIcon("notes", Note01Icon);
export const IconPalette = defineIcon("palette", PaintBoardIcon);
export const IconPencil = defineIcon("pencil", PencilEdit02Icon);
export const IconPhoto = defineIcon("photo", Image01Icon);
export const IconPin = defineIcon("pin", PinIcon);
export const IconPinFilled = defineIcon("pin-filled", PinIcon, {
  filled: true,
});
export const IconPinnedOff = defineIcon("pinned-off", PinOffIcon);
export const IconPlayerPause = defineIcon("player-pause", PauseIcon);
export const IconPlayerPlay = defineIcon("player-play", PlayIcon);
export const IconPlayerRecordFilled = defineIcon(
  "player-record-filled",
  RecordIcon,
  { filled: true },
);
export const IconPlayerStop = defineIcon("player-stop", StopIcon);
export const IconPlayerStopFilled = defineIcon("player-stop-filled", StopIcon, {
  filled: true,
});
export const IconPlug = defineIcon("plug", [
  [
    "path",
    {
      d: "M15.5 6V5.5C15.5 4.096 15.5 3.393 15.163 2.889C15.017 2.67 14.83 2.483 14.612 2.337C14.107 2 13.405 2 12 2C10.596 2 9.894 2 9.389 2.337C9.171 2.483 8.983 2.67 8.837 2.889C8.5 3.393 8.5 4.096 8.5 5.5V6",
      key: "prongs",
      ...GLYPH_STROKE,
    },
  ],
  [
    "path",
    {
      d: "M10.82 18H13.181C18.051 18 18.882 11.444 19.195 7.76C19.276 6.81 18.433 6 17.364 6H6.637C5.568 6 4.725 6.81 4.806 7.76C5.094 11.148 6.245 18 10.82 18Z",
      key: "body",
      ...GLYPH_STROKE,
    },
  ],
  ["path", { d: "M12 18V22.8M11 9.7H13", key: "cord", ...GLYPH_STROKE }],
]);
export const IconPlugConnected = defineIcon("plug-connected", PlugSocketIcon);
export const IconPlugOff = defineIcon("plug-off", Plug02Icon);
export const IconPlus = defineIcon("plus", PlusSignIcon);
export const IconPointer = defineIcon("pointer", Cursor01Icon);
export const IconPresentation = defineIcon(
  "presentation",
  PresentationBarChart01Icon,
);
export const IconProgress = defineIcon("progress", Progress01Icon);
export const IconPuzzle = defineIcon("puzzle", PuzzleIcon);
export const IconRadar = defineIcon("radar", Radar01Icon);
export const IconRefresh = defineIcon("refresh", RefreshIcon);
export const IconReload = defineIcon("reload", ReloadIcon);
export const IconRepeat = defineIcon("repeat", RepeatIcon);
export const IconRobot = defineIcon("robot", Robot01Icon);
export const IconRoute = defineIcon("route", Route01Icon);
export const IconSchool = defineIcon("school", Mortarboard02Icon);
export const IconSearch = defineIcon("search", Search01Icon);
export const IconSelector = defineIcon("selector", UnfoldMoreIcon);
export const IconSend = defineIcon("send", SentIcon);
export const IconServer = defineIcon("server", ServerStack01Icon);
export const IconSettings = defineIcon("settings", Settings01Icon);
export const IconShare = defineIcon("share", Share08Icon);
export const IconShieldCheck = defineIcon("shield-check", SecurityCheckIcon);
export const IconShieldLock = defineIcon("shield-lock", SecurityLockIcon);
export const IconShieldX = defineIcon("shield-x", SecurityBlockIcon);
export const IconSitemap = defineIcon("sitemap", HierarchyIcon);
export const IconSparkles = defineIcon("sparkles", SparklesIcon);
export const IconSpeakerphone = defineIcon("speakerphone", Megaphone01Icon);
export const IconSquareCheck = defineIcon(
  "square-check",
  CheckmarkSquare02Icon,
);
export const IconStack2 = defineIcon("stack-2", Layers01Icon);
export const IconStar = defineIcon("star", StarIcon);
export const IconSubtask = defineIcon("subtask", HierarchySquare02Icon);
export const IconSunMoon = defineIcon("sun-moon", SunMoonIcon);
export const IconTable = defineIcon("table", Table01Icon);
export const IconTag = defineIcon("tag", Tag01Icon);
export const IconTarget = defineIcon("target", Target01Icon);
export const IconTargetArrow = defineIcon("target-arrow", Target02Icon);
export const IconTerminal2 = defineIcon("terminal-2", ComputerTerminal01Icon);
export const IconTextCaption = defineIcon("text-caption", TextIcon);
export const IconToggleRight = defineIcon("toggle-right", ToggleOnIcon);
export const IconTool = defineIcon("tool", Wrench01Icon);
export const IconTrash = defineIcon("trash", Delete02Icon);
export const IconTriangleSquareCircle = defineIcon(
  "triangle-square-circle",
  ShapesIcon,
);
export const IconUser = defineIcon("user", UserIcon);
export const IconUserCheck = defineIcon("user-check", UserCheck01Icon);
export const IconUserCircle = defineIcon("user-circle", UserCircleIcon);
export const IconUserCog = defineIcon("user-cog", UserSettings01Icon);
export const IconUserShield = defineIcon("user-shield", UserShield01Icon);
export const IconUsers = defineIcon("users", UserGroupIcon);
export const IconUsersGroup = defineIcon("users-group", UserMultipleIcon);
export const IconVideo = defineIcon("video", Video01Icon);
export const IconWebhook = defineIcon("webhook", WebhookIcon);
export const IconWorld = defineIcon("world", Globe02Icon);
export const IconWorldOff = defineIcon("world-off", GlobeOffIcon);
export const IconX = defineIcon("x", Cancel01Icon);
export const IconZoomQuestion = defineIcon("zoom-question", SearchList02Icon);
