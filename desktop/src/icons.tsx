/*
 * OpenBot Desktop's icons, from Hugeicons' free set (MIT, Stroke Rounded): the one icon set every
 * app uses (docs/design-system.md, "The rest of the look"). The web app's are in
 * app/src/components/icons; this package can't import from the app, so its few live here, under the
 * same names and drawn the same way.
 */
import {
  AiBrain01Icon,
  ArrowUpRight01Icon,
  BookOpen01Icon,
  Building03Icon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  CloudIcon,
  CloudServerIcon,
  ComputerIcon,
  Files01Icon,
  HistoryIcon,
  LaptopIcon,
  Login01Icon,
  Message02Icon,
  Mortarboard02Icon,
  Notification01Icon,
  Plug01Icon,
  Robot01Icon,
  ServerStack01Icon,
  SlidersHorizontalIcon,
  SourceCodeIcon,
  SparklesIcon,
  Target01Icon,
  TickDouble02Icon,
  UserGroupIcon,
  UserIcon,
  UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  type ForwardRefExoticComponent,
  forwardRef,
  type RefAttributes,
  type SVGProps,
} from "react";

export type IconProps = Omit<
  SVGProps<SVGSVGElement>,
  "ref" | "stroke" | "strokeWidth"
> & {
  /** Width and height, 24 by default. */
  size?: number | string;
  /** The line's width on the icon's 24-unit grid. The set's 1.5 by default. */
  stroke?: number | string;
};

export type Icon = ForwardRefExoticComponent<
  IconProps & RefAttributes<SVGSVGElement>
>;

/** An icon from a Hugeicons glyph, with the `icon icon-<name>` classes the web app's carry. */
function defineIcon(name: string, glyph: IconSvgElement): Icon {
  const Component = forwardRef<SVGSVGElement, IconProps>(
    ({ className, stroke, ...props }, ref) => (
      <HugeiconsIcon
        ref={ref}
        icon={glyph}
        className={["icon", `icon-${name}`, className]
          .filter(Boolean)
          .join(" ")}
        {...(stroke === undefined ? {} : { strokeWidth: Number(stroke) })}
        {...props}
      />
    ),
  );
  Component.displayName = `Icon(${name})`;
  return Component;
}

export const IconAdjustments = defineIcon("adjustments", SlidersHorizontalIcon);
export const IconArrowUpRight = defineIcon(
  "arrow-up-right",
  ArrowUpRight01Icon,
);
export const IconBell = defineIcon("bell", Notification01Icon);
export const IconBook = defineIcon("book", BookOpen01Icon);
export const IconBrain = defineIcon("brain", AiBrain01Icon);
export const IconBuilding = defineIcon("building", Building03Icon);
export const IconChecks = defineIcon("checks", TickDouble02Icon);
export const IconCircleCheck = defineIcon(
  "circle-check",
  CheckmarkCircle02Icon,
);
export const IconClock = defineIcon("clock", Clock01Icon);
export const IconCloud = defineIcon("cloud", CloudIcon);
export const IconCloudComputing = defineIcon(
  "cloud-computing",
  CloudServerIcon,
);
export const IconCode = defineIcon("code", SourceCodeIcon);
export const IconDeviceDesktop = defineIcon("device-desktop", ComputerIcon);
export const IconDeviceLaptop = defineIcon("device-laptop", LaptopIcon);
export const IconFiles = defineIcon("files", Files01Icon);
export const IconHistory = defineIcon("history", HistoryIcon);
export const IconListCheck = defineIcon("list-check", CheckListIcon);
export const IconLogin2 = defineIcon("login-2", Login01Icon);
export const IconMessages = defineIcon("messages", Message02Icon);
export const IconPlug = defineIcon("plug", Plug01Icon);
export const IconRobot = defineIcon("robot", Robot01Icon);
export const IconSchool = defineIcon("school", Mortarboard02Icon);
export const IconServer2 = defineIcon("server-2", ServerStack01Icon);
export const IconSparkles = defineIcon("sparkles", SparklesIcon);
export const IconTarget = defineIcon("target", Target01Icon);
export const IconUser = defineIcon("user", UserIcon);
export const IconUsers = defineIcon("users", UserGroupIcon);
export const IconUsersGroup = defineIcon("users-group", UserMultipleIcon);
