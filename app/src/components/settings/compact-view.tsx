import { IconPictureInPicture } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { setCompactViewMutationOptions } from "@/lib/desktop/mutations";
import { desktopCompactViewQueryOptions } from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { queryClient } from "@/query-client";

/**
 * Settings → General → Appearance's Compact view: OpenBot as a small bubble over the person's other
 * apps, in place of this window. Switched on, the desktop app hides this window at once and shows the
 * bubble (desktop/src-tauri/src/assistant.rs); the bubble's panel turns it off again.
 *
 * A row of the Appearance card, after the skin, with its own separator: drawn only in OpenBot
 * Desktop on a Mac, showing the OpenBot that runs on it. An older desktop app that can't say draws
 * nothing.
 */
export function CompactViewRow() {
  const compactView = useQuery(desktopCompactViewQueryOptions());
  const change = useMutation(setCompactViewMutationOptions(queryClient));
  if (desktopShell() === null || !compactView.data?.available) return null;
  return (
    <>
      <Separator />
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconPictureInPicture />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Compact view</ItemTitle>
          <ItemDescription className="line-clamp-none">
            OpenBot shows as a small bubble over your other apps, in place of
            this window. Drag it anywhere, and click it to open your
            conversations.
          </ItemDescription>
          {change.error ? (
            <p className="text-destructive text-sm" role="alert">
              Couldn't change this setting. Try again.
            </p>
          ) : null}
        </ItemContent>
        <ItemActions>
          <Switch
            aria-label="Compact view"
            checked={compactView.data.on}
            disabled={change.isPending}
            onCheckedChange={(on) => change.mutate(on)}
          />
        </ItemActions>
      </Item>
    </>
  );
}
