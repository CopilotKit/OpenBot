import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { IconSearch, IconX } from "@/components/icons";
import { cn } from "@/lib/utils";

/*
 * The UI Kit's "Search": a pill with the search glyph at its start, gray until something is typed,
 * and a round clear button at its end once there is, as far from the end as from the top and the
 * bottom. Under the pointer its edge darkens, as a field's does; while focused a 4px #d8dee9 band
 * stands round it in place of its edge.
 *
 * Its sizes: S is `sm` (32px, the glyph 6px in), M is `lg` (48px, the glyph 16px in). The kit's
 * fields and menus are 40px, which is `Input`; a search of that size can join them when a screen
 * needs one.
 *
 * The large one is also drawn under the alternate skins (a browser's empty tab), so its height,
 * fill, shadow and focus are tokens (theme.css), which the skins set back to the field they had
 * there (skins/legacy-base.css).
 */
const searchFieldVariants = cva(
  "group/search flex w-full min-w-0 items-center rounded-full border border-field-border text-sm transition-[border-color,box-shadow] duration-150 ease-out hover:border-field-border-hover has-[input:focus-visible]:border-search-focus-border has-[input:focus-visible]:ring-(length:--search-focus-ring) has-[input:focus-visible]:ring-search-focus-ring has-[input:disabled]:pointer-events-none has-[input:disabled]:opacity-50",
  {
    variants: {
      size: {
        sm: "h-8 gap-2.5 bg-card pr-1.25 pl-1.5",
        lg: "h-search-lg gap-search-lg-gap bg-search-lg pr-3.25 pl-4 shadow-(--search-lg-shadow)",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

function SearchField({
  size = "sm",
  className,
  value,
  onClear,
  clearLabel = "Clear search",
  ...props
}: Omit<React.ComponentProps<"input">, "size"> &
  VariantProps<typeof searchFieldVariants> & {
    /** Shown as the round clear button while there is a value. Left out, there is no button. */
    onClear?: () => void;
    clearLabel?: string;
  }) {
  const filled = value !== undefined && String(value).length > 0;
  return (
    <div
      data-slot="search-field"
      data-size={size}
      className={cn(searchFieldVariants({ size }), className)}
    >
      <IconSearch
        aria-hidden
        className={cn(
          "pointer-events-none size-field-icon shrink-0 transition-colors",
          filled ? "text-foreground" : "text-search-icon",
        )}
      />
      <input
        data-slot="search-field-input"
        className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-field-placeholder"
        value={value}
        {...props}
      />
      {onClear && filled ? (
        <button
          aria-label={clearLabel}
          className="grid size-5 shrink-0 place-items-center rounded-full bg-secondary-hover text-field-disabled transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={onClear}
          type="button"
        >
          <IconX className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

export { SearchField, searchFieldVariants };
