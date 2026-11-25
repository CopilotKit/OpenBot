import { Text as NativeText, type TextProps } from "react-native";
import { tv, type VariantProps } from "tailwind-variants";
import { cn } from "./cn";

/**
 * Text in Inter, from the type scale. Every word on a screen is one of these: React Native passes
 * no font down from a parent, so a bare `Text` would draw in the system face.
 *
 * - `title`: a screen's own heading ("Your conversations").
 * - `heading`: a section, or a name at the top of a page.
 * - `body`: what a person reads: messages, rows.
 * - `label`: a control's or a row's name.
 * - `caption`: a time, a count, a Bot's name over a line.
 */
const text = tv({
  base: "font-normal text-foreground",
  variants: {
    variant: {
      title: "font-semibold text-2xl",
      heading: "font-semibold text-lg",
      body: "text-base leading-6",
      label: "font-medium text-base",
      caption: "text-xs",
    },
    tone: {
      default: "",
      muted: "text-muted",
      danger: "text-danger",
      success: "text-success",
      warning: "text-warning",
    },
  },
  defaultVariants: { variant: "body", tone: "default" },
});

export type TextVariant = VariantProps<typeof text>;

export function Text({
  variant,
  tone,
  className,
  ...props
}: TextProps & TextVariant & { className?: string }) {
  return (
    <NativeText
      accessibilityRole={
        variant === "title" || variant === "heading" ? "header" : undefined
      }
      {...props}
      className={cn(text({ variant, tone }), className)}
    />
  );
}
