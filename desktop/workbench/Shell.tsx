import { IconAlertTriangle, IconChevronDown } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
} from "@/components/ui/item";
import { toast } from "@/components/ui/toast";

/*
 * The parts of the workbench page around the panels (Workbench.tsx): the sections that fold open,
 * the notices over the stage, the handover cards and the short messages. All of them are the
 * app's components.
 */

export type FoldProps = {
  title: string;
  /** Set when the page opens the section itself (a picked route opens "API answers"). */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  defaultOpen?: boolean;
  children: ReactNode;
};

/**
 * A section that folds open. Its content stays in the page while it is closed, as in the old
 * HTML details element, so a panel keeps what you typed and picked in it.
 */
export function Fold(props: FoldProps) {
  return (
    <Collapsible
      open={props.open}
      onOpenChange={props.onOpenChange}
      defaultOpen={props.defaultOpen}
      className="border-t border-border pt-2"
    >
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-auto min-h-7 w-full justify-between py-1 text-left whitespace-normal"
          />
        }
      >
        <span className="min-w-0 break-words">{props.title}</span>
        <IconChevronDown
          aria-hidden="true"
          className="text-muted-foreground transition-transform duration-150 group-data-[panel-open]/button:rotate-180 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted className="pt-2">
        {props.children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** What went wrong, over the top of the stage, each with its own Close. */
export function NoticeList(props: {
  notices: readonly string[];
  onClose(index: number): void;
}) {
  if (props.notices.length === 0) return null;
  return (
    <div className="absolute inset-x-2 top-2 z-10 flex flex-col gap-1">
      {props.notices.map((text, index) => (
        <Item
          // A notice has no id, and the list only shrinks.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
          key={`${index}|${text}`}
          variant="outline"
          size="xs"
          role="status"
          className="bg-popover text-popover-foreground shadow-md"
        >
          <ItemMedia>
            <IconAlertTriangle
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <span>{text}</span>
          </ItemContent>
          <ItemActions>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => props.onClose(index)}
            >
              Close
            </Button>
          </ItemActions>
        </Item>
      ))}
    </div>
  );
}

export function tell(text: string, type?: "error"): void {
  toast.add({ title: text, type });
}
