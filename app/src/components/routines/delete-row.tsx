import { IconTrash } from "@tabler/icons-react";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";

/**
 * The last row of a goal's, a schedule's or a check-in's actions card: delete it, after a
 * confirmation the page opens. A row in the card with the page's other actions, never a button left
 * on its own under the page, which reads as something that fell out of the layout.
 */
export function DeleteRow({
  title,
  description,
  label,
  onClick,
}: {
  title: string;
  /** What deleting takes with it, said before the confirmation asks. */
  description: string;
  /** The accessible name, where the title alone doesn't say which one. */
  label?: string;
  onClick: () => void;
}) {
  return (
    <Item
      render={<button aria-label={label} onClick={onClick} type="button" />}
      size="sm"
    >
      <ItemMedia variant="icon">
        <IconTrash />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="text-destructive">{title}</ItemTitle>
        <ItemDescription>{description}</ItemDescription>
      </ItemContent>
    </Item>
  );
}
