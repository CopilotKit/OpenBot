import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  /*
   * The UI Kit's "Button" and "Icon Button": pills labelled in 14px semibold, with the label and
   * its icon 4px apart. A state is a colour of its own (theme.css: `--color-primary-hover` and the
   * rest), not the button faded or nudged.
   *
   * The alternate skins keep the buttons they were drawn with: every colour and measure here that
   * differs between the two is a token (theme.css), which the skins set back to theirs
   * (skins/legacy-base.css): the fade when disabled, the 1px press, the smaller icons, the tighter
   * end beside an icon and the link's underline. A call site's own class still replaces any of
   * them, under a skin too.
   *
   * The kit's variants by name: Primary is `default`, Secondary is `secondary` and also `outline`,
   * which the kit does not have, Tertiary is `ghost`, Link is `link`. `destructive` is the app's own.
   * Its sizes: M is `default` (36px, 16px in from each end, 20px icons), S is `sm` (32px, 12px in,
   * 18px icons), and the round Icon Button M is `icon-lg` (36px, an 18px glyph). Each size sets its
   * own icon, none is set here: `buttonVariants()` is used without `cn` in places, where a size
   * written here as well would leave two in the class list and the stylesheet's order to choose.
   */
  "group/button inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding text-sm leading-tight font-semibold whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate,opacity] duration-150 ease-out outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-(--button-press-shift) disabled:pointer-events-none disabled:opacity-(--button-disabled-opacity) aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active disabled:text-primary-disabled",
        outline:
          "border-outline-border bg-outline hover:bg-outline-hover hover:text-foreground active:bg-outline-active aria-expanded:bg-outline-expanded aria-expanded:text-foreground disabled:text-outline-disabled",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary-hover active:bg-secondary-active aria-expanded:bg-secondary-expanded aria-expanded:text-secondary-foreground disabled:text-secondary-disabled",
        ghost:
          "hover:bg-ghost-hover hover:text-foreground active:bg-ghost-active aria-expanded:bg-ghost-expanded aria-expanded:text-foreground disabled:text-ghost-disabled",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 disabled:opacity-50 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        // The kit's Link: the ink label, darker as it is pressed, with no underline.
        link: "text-primary underline-offset-4 hover:text-link-hover hover:[text-decoration-line:var(--link-hover-decoration)] active:text-link-active disabled:text-link-disabled",
      },
      size: {
        default:
          "h-9 gap-1 px-4 in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-button-edge has-data-[icon=inline-start]:pl-button-edge [&_svg:not([class*='size-'])]:size-button-icon",
        xs: "h-6 gap-1 px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1 px-3 in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-button-edge-sm has-data-[icon=inline-start]:pl-button-edge-sm [&_svg:not([class*='size-'])]:size-button-icon-sm",
        lg: "h-10 gap-1 px-5 in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4 [&_svg:not([class*='size-'])]:size-5",
        icon: "size-8 in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-[18px]",
        "icon-xs":
          "size-6 in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-4",
        "icon-lg":
          "size-9 in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-[18px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  render,
  /*
   * DIVERGES FROM UPSTREAM SHADCN. Base UI defaults `nativeButton` to `true`, which is right only
   * while the element really is a `<button>`. Six call sites here draw a router `Link` through
   * `render` instead — "New skill", "New agent", the sidebar's new-channel control, the two
   * empty-state returns, and `PageShell`'s back button, which is five routes in every state each of
   * them has — and every one of them warned at render that it had been told to expect a native
   * button and found an anchor. It was not only noise: Base UI was putting `type="button"` on an
   * anchor, which means nothing there, and withholding the `role="button"` and Space-to-activate
   * handling a non-button needs in order to behave like one.
   *
   * Replacing the element is exactly the case where the default is wrong, so the default follows
   * `render`, once here rather than at every call site. Passing `render` is not proof the result is
   * a non-button, only that we can no longer assume it is one, so a call site drawing a real
   * `<button>` through `render` passes `nativeButton` back explicitly — `combobox.tsx` is the one
   * that does.
   */
  nativeButton = render === undefined,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      nativeButton={nativeButton}
      render={render}
      {...props}
    />
  );
}

export { Button, buttonVariants };
