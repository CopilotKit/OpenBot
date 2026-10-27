import {
  IconArrowUpRight,
  IconChevronRight,
  type IconProps,
  IconX,
} from "@tabler/icons-react";
import * as React from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { cn } from "@/lib/utils";
import type { MascotTint } from "./model";

/*
 * OpenMuse's primitives, rebuilt on OpenBot's own. Each one is an OpenBot component — Button, Item,
 * Dialog — wearing OpenMuse's measurements: 23px cards, pill buttons, 42px icon tiles, a 44px round
 * icon button, and the 15/14/11px type steps from its stylesheet. Colours come from the skin's tokens,
 * so dark mode follows without a branch here.
 */

export type MuseIcon = React.ComponentType<IconProps>;

export const museText = {
  body: "text-[15px] leading-[23px] text-foreground",
  muted: "text-[14px] leading-[21px] text-muted-foreground",
  small: "text-[11px] leading-[17px] text-muted-foreground",
  heading: "text-[16px] font-semibold tracking-[-0.25px] text-foreground",
  title: "text-[23px] font-semibold tracking-[-0.7px] text-foreground",
} as const;

type MuseButtonLook = { primary?: boolean; small?: boolean; danger?: boolean };

/** OpenMuse's pill: pale blue when it is the one thing to do, soft grey otherwise. */
export function museButtonClass({
  primary = false,
  small = false,
  danger = false,
}: MuseButtonLook = {}) {
  return cn(
    buttonVariants({ variant: "secondary" }),
    "h-auto min-h-[42px] gap-2 rounded-full border-0 px-[17px] py-2.5 font-semibold text-[14px] shadow-none active:translate-y-0 active:scale-[0.98] [&_svg]:size-[15px]",
    primary
      ? "bg-primary text-primary-foreground hover:bg-[var(--openmuse-primary-hover)]"
      : "bg-secondary text-secondary-foreground hover:bg-[var(--openmuse-pressed)]",
    danger && "text-destructive",
    small && "min-h-[38px] px-[13px] py-[7px]",
  );
}

export function MuseButton({
  children,
  className,
  icon: Icon,
  primary,
  small,
  danger,
  ...props
}: React.ComponentProps<typeof Button> &
  MuseButtonLook & {
    icon?: MuseIcon;
  }) {
  return (
    <Button
      className={cn(museButtonClass({ primary, small, danger }), className)}
      variant="secondary"
      {...props}
    >
      {Icon ? <Icon stroke={1.9} /> : null}
      {children}
    </Button>
  );
}

/**
 * A pill that goes somewhere. Base UI's Button gives an anchor the button role, so a destination is
 * an anchor of its own wearing the same pill, and keeps its link role.
 */
export function MuseLinkButton({
  children,
  className,
  icon: Icon,
  primary,
  small,
  danger,
  render,
}: MuseButtonLook & {
  children: React.ReactNode;
  className?: string;
  icon?: MuseIcon;
  render: React.ReactElement<{
    className?: string;
    children?: React.ReactNode;
  }>;
}) {
  return React.cloneElement(render, {
    className: cn(museButtonClass({ primary, small, danger }), className),
    children: (
      <>
        {Icon ? <Icon aria-hidden="true" stroke={1.9} /> : null}
        {children}
      </>
    ),
  });
}

/** The round white button in the top bar and on every sheet. */
export function RoundButton({
  icon: Icon,
  label,
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & { icon: MuseIcon; label: string }) {
  return (
    <button
      aria-label={label}
      className={cn(
        "relative flex size-11 shrink-0 items-center justify-center rounded-full bg-card text-foreground outline-none transition-colors hover:bg-[var(--openmuse-pressed)] focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
      type="button"
      {...props}
    >
      <Icon className="size-5" stroke={1.8} />
      {children}
    </button>
  );
}

export function MuseCard({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-[23px] bg-card p-5 text-foreground", className)}
      {...props}
    />
  );
}

const CHIP_TINTS = {
  plain: "bg-[var(--openmuse-chip)]",
  sky: "bg-[var(--openmuse-sky)]",
  green: "bg-[var(--openmuse-green)]",
  lavender: "bg-[var(--openmuse-lavender)]",
  orange: "bg-[var(--openmuse-orange)]",
  danger: "bg-[var(--openmuse-danger-tint)] text-destructive",
} as const;

export type ChipTint = keyof typeof CHIP_TINTS;

export function MuseChip({
  children,
  tint = "plain",
  className,
}: {
  children: React.ReactNode;
  tint?: ChipTint;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center self-start rounded-full px-2.5 py-1 font-semibold text-[10px] text-muted-foreground leading-none",
        CHIP_TINTS[tint],
        className,
      )}
    >
      {children}
    </span>
  );
}

const TILE_TINTS = {
  sky: "bg-[var(--openmuse-sky)]",
  green: "bg-[var(--openmuse-green)]",
  lavender: "bg-[var(--openmuse-lavender)]",
  orange: "bg-[var(--openmuse-orange)]",
  plain: "bg-secondary",
} as const;

export type TileTint = keyof typeof TILE_TINTS;

/** OpenMuse's rounded square that holds an icon. */
export function IconTile({
  icon: Icon,
  tint = "sky",
  size = 42,
  accent = false,
  className,
}: {
  icon: MuseIcon;
  tint?: TileTint;
  size?: 34 | 42 | 55;
  accent?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center",
        size === 55 ? "size-[55px] rounded-[18px]" : "rounded-[13px]",
        size === 42 && "size-[42px]",
        size === 34 && "size-[34px]",
        TILE_TINTS[tint],
        accent ? "text-[var(--openmuse-accent)]" : "text-foreground",
        className,
      )}
    >
      <Icon
        className={
          size === 55 ? "size-6" : size === 34 ? "size-[18px]" : "size-[19px]"
        }
        stroke={1.8}
      />
    </span>
  );
}

/**
 * A row that leads somewhere: tile, title, one line of detail, chevron. `render` is the element it
 * is drawn as — a router `Link` for a page, a `button` for a sheet — exactly as `Item` takes it.
 */
export function LinkRow({
  icon,
  title,
  detail,
  tint = "sky",
  render,
  trailing,
}: {
  icon: MuseIcon;
  title: React.ReactNode;
  detail?: React.ReactNode;
  tint?: TileTint;
  render: React.ComponentProps<typeof Item>["render"];
  trailing?: React.ReactNode;
}) {
  return (
    <Item
      className="flex-nowrap gap-3.5 rounded-[10px] border-0 px-0 py-[13px] hover:bg-transparent active:bg-[var(--openmuse-pressed)] [a]:hover:bg-transparent"
      render={render}
    >
      <ItemMedia className="translate-y-0! self-center!">
        <IconTile icon={icon} tint={tint} />
      </ItemMedia>
      <ItemContent className="min-w-0 gap-[3px]">
        <ItemTitle className="font-medium text-[15px] leading-[23px]">
          {title}
        </ItemTitle>
        {detail ? (
          <ItemDescription
            className={cn(museText.small, "line-clamp-1 text-[11px]")}
          >
            {detail}
          </ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions className="gap-2">
        {trailing}
        <IconChevronRight
          aria-hidden="true"
          className="size-[15px] text-muted-foreground"
        />
      </ItemActions>
    </Item>
  );
}

export function SectionHeading({
  title,
  action,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("mb-[19px] flex items-center justify-between", className)}
    >
      <h2 className={museText.heading}>{title}</h2>
      {action}
    </div>
  );
}

/** "See all" beside a heading: OpenMuse's small text link with its up-right arrow. */
export function HeadingLink({
  children,
  render,
}: {
  children: React.ReactNode;
  render: React.ReactElement;
}) {
  return (
    <Item
      className="w-auto flex-nowrap gap-[5px] border-0 p-0 text-[11px] text-foreground [a]:hover:bg-transparent [a]:hover:underline"
      render={render}
    >
      {children}
      <IconArrowUpRight
        aria-hidden="true"
        className="size-[13px] text-muted-foreground"
      />
    </Item>
  );
}

export function MuseEmpty({
  icon,
  title,
  detail,
  children,
}: {
  icon: MuseIcon;
  title: string;
  detail: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-[13px] p-10 text-center">
      <IconTile accent icon={icon} size={55} />
      <h3 className={museText.heading}>{title}</h3>
      <p className={cn(museText.muted, "max-w-[360px] text-pretty")}>
        {detail}
      </p>
      {children}
    </div>
  );
}

export function ErrorNotice({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    <div
      className="my-2.5 rounded-[14px] bg-[var(--openmuse-danger-tint)] p-4 text-[15px] text-destructive leading-[23px]"
      role="alert"
    >
      {error}
    </div>
  );
}

export function Divider({ className }: { className?: string }) {
  return <div className={cn("h-px bg-border", className)} />;
}

/** A coloured status dot, as on OpenMuse's Tracking and Goals headings. */
export function StatusDot({ tone }: { tone: "green" | "blue" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-4 shrink-0 rounded-full border-[5px]",
        tone === "green"
          ? "border-[var(--openmuse-green-ring)] bg-[var(--openmuse-green-dot)]"
          : "border-[var(--openmuse-blue-ring)] bg-[var(--openmuse-blue-dot)]",
      )}
    />
  );
}

export const MASCOT_SRC = "/skins/openmuse/capybara.png";

const MASCOT_TINTS: Record<MascotTint, string> = {
  sky: "bg-[var(--openmuse-tint-sky)]",
  sand: "bg-[var(--openmuse-tint-sand)]",
  lilac: "bg-[var(--openmuse-tint-lilac)]",
};

/**
 * OpenMuse's capybara on its tinted disc: how OpenMuse draws an agent. Sized by `size`, or by a
 * class when the size changes with the viewport; the disc is placed in proportion either way.
 */
export function Mascot({
  size,
  className,
  tint = "sky",
}: {
  size?: number;
  className?: string;
  tint?: MascotTint;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("relative block shrink-0", className)}
      style={size ? { height: size, width: size } : undefined}
    >
      <span
        className={cn(
          "absolute top-[15%] left-[12%] size-[76%] rounded-full",
          MASCOT_TINTS[tint],
        )}
      />
      <img
        alt=""
        className="relative block size-full object-contain"
        draggable={false}
        src={MASCOT_SRC}
      />
    </span>
  );
}

/**
 * OpenMuse's sheet: a card that rises from the bottom on a phone, with a grab handle, and settles in
 * the middle on anything wider. Built on OpenBot's Dialog, so focus, Escape and the backdrop behave
 * the way every other OpenBot dialog does.
 */
export function MuseSheet({
  title,
  subtitle,
  children,
  onClose,
  bodyRef,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
  bodyRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent
        className={cn(
          "openmuse-sheet gap-0 overflow-hidden border border-border bg-background p-0 text-foreground shadow-none",
          // A phone: pinned to the bottom edge, full width, square at the bottom.
          "top-auto bottom-0 left-0 max-h-[94svh] w-full max-w-none translate-x-0 translate-y-0 rounded-[26px] rounded-b-none pb-3",
          // Wider: centred, OpenMuse's 790px card.
          "min-[600px]:top-1/2 min-[600px]:bottom-auto min-[600px]:left-1/2 min-[600px]:w-[calc(100%-40px)] min-[600px]:max-w-[790px] min-[600px]:-translate-x-1/2 min-[600px]:-translate-y-1/2 min-[600px]:rounded-[26px] min-[600px]:pb-0",
        )}
        overlayClassName="bg-[var(--openmuse-scrim)] supports-backdrop-filter:backdrop-blur-none"
        showCloseButton={false}
      >
        <span
          aria-hidden="true"
          className="mx-auto mt-2.5 block h-1 w-[34px] shrink-0 rounded-[3px] bg-[var(--openmuse-handle)] min-[600px]:hidden"
        />
        <div className="flex shrink-0 items-center justify-between gap-4 border-border border-b p-5 min-[600px]:p-6">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <DialogTitle className={cn(museText.title, "font-semibold")}>
              {title}
            </DialogTitle>
            {subtitle ? (
              <DialogDescription className={museText.muted}>
                {subtitle}
              </DialogDescription>
            ) : null}
          </div>
          <RoundButton icon={IconX} label="Close" onClick={onClose} />
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto p-5 min-[600px]:p-6"
          ref={bodyRef}
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** OpenMuse's text field: a label above a 45px rounded input, or a taller box for prose. */
export function MuseField({
  label,
  value,
  onChange,
  placeholder,
  multiline = false,
  bare = false,
  className,
}: {
  label: string;
  value: string;
  onChange: (
    event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
  placeholder?: string;
  multiline?: boolean;
  /** No margin of its own, for a field that sits in a container that already spaces its children. */
  bare?: boolean;
  className?: string;
}) {
  const field = cn(
    "w-full rounded-[19px] border border-border bg-card px-4 py-3 text-[16px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-[var(--openmuse-focus)]",
    multiline ? "min-h-[120px] resize-y" : "min-h-[45px]",
    className,
  );
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the label's child.
    <label className={cn("flex flex-col gap-[7px]", !bare && "mb-4")}>
      <span className="font-semibold text-[11px] text-foreground leading-[17px]">
        {label}
      </span>
      {multiline ? (
        <textarea
          className={field}
          onChange={onChange}
          placeholder={placeholder}
          value={value}
        />
      ) : (
        <input
          className={field}
          onChange={onChange}
          placeholder={placeholder}
          value={value}
        />
      )}
    </label>
  );
}

/** The scrolling page every OpenMuse tab is drawn on, with its 25px title. */
export function MuseScreen({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-[22px] pb-7 min-[900px]:px-[42px]">
        <h1 className="mb-[22px] font-semibold text-[25px] text-foreground tracking-[-0.7px]">
          {title}
        </h1>
        {children}
      </div>
    </div>
  );
}
