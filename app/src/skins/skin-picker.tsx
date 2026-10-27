import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SKINS } from "./registry";
import { setSkin, useSkinId } from "./store";
import { SKIN_IDS } from "./types";

export function SkinPicker() {
  const skin = useSkinId();

  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>Skin</ItemTitle>
        <ItemDescription>
          Change how OpenBot looks for you. Every skin keeps everything OpenBot
          does.
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Select
          value={skin}
          onValueChange={(value) => {
            const id = SKIN_IDS.find((known) => known === value);
            if (id) setSkin(id);
          }}
        >
          <SelectTrigger aria-label="Skin">
            <SelectValue>{SKINS[skin].name}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SKIN_IDS.map((id) => (
              <SelectItem key={id} value={id}>
                {SKINS[id].name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ItemActions>
    </Item>
  );
}
