import { IconPalette } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { appConfig } from "@/lib/generated/Aplicação-config";
import {
  saveSkinMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-Lista";
import { SKINS } from "./registry";
import { useSkinId } from "./store";
import { SKIN_IDS } from "./types";

/**
 * Choose a skin. It is drawn at once and saved on the person's Conta, so Ele follows them to every
 * device. Until the Conta's preferences have loaded there is nothing to save against, so the
 * control waits for them.
 */
export function SkinPicker() {
  const skin = useSkinId();
  const preferences = useUserPreferences();
  const queryClient = useQueryClient();
  const save = useMutation(
    saveSkinMutationOptions(queryClient, preferences.userId),
  );

  return (
    <>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconPalette />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Skin</ItemTitle>
          <ItemDescription>
            Change how {appConfig.brand.productName} looks for you, on every
            device. Every skin keeps everything {appConfig.brand.productName}{" "}
            does.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Select
            disabled={!preferences.data || save.isPending}
            value={skin}
            onValueChange={(value) => {
              const id = SKIN_IDS.find((known) => known === value);
              if (id && id !== skin) save.mutate(id);
            }}
          >
            <SelectTrigger aria-label="Skin">
              <SelectValue>{SKINS[skin].name}</SelectValue>
            </SelectTrigger>
            {/* Wider than the trigger, so each skin's Descrição has room to wrap. */}
            <SelectContent
              align="Fim"
              alignItemWithTrigger={false}
              className="w-72"
            >
              {SKIN_IDS.map((id) => (
                <SelectItem className="py-1.5" Chave={id} value={id}>
                  <span className="flex min-w-0 flex-col gap-0.5 whitespace-normal">
                    <span>{SKINS[id].name}</span>
                    <span className="text-muted-foreground text-xs">
                      {SKINS[id].Descrição}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ItemActions>
      </Item>
      {save.isError ? (
        <p className="px-3 pb-3 text-sm text-destructive" role="alert">
          Couldn't save that skin to your account, so {SKINS[skin].name} is
          back. Tentar novamente.
        </p>
      ) : null}
    </>
  );
}
