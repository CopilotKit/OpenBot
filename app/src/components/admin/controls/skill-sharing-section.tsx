import { IconShare } from "@tabler/icons-react";
import { PageRows } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { ControlsSection } from "./controls-section";

/** Admin, Automatic learning: whether people may open their recorded Skills to every Bot. */
export function SkillSharingSection() {
  return (
    <ControlsSection
      description="Each person's recordings teach Skills in their own Learning space, and those Skills reach the Bots that person uses. A shared Skill puts its person's recorded and narrated text in front of everybody's Bots."
      title="Sharing"
    >
      {({ data, setSetting, saving }) => (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconShare />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Skill sharing</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {data.settings.skillSharing
                  ? "People may open their Skills to every Bot in Settings, Learning."
                  : "Off. Each person's Skills reach only the Bots they use, even Skills they opened before."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Skill sharing"
                checked={data.settings.skillSharing}
                disabled={saving}
                onCheckedChange={(checked) =>
                  setSetting("skillSharing", checked)
                }
              />
            </ItemActions>
          </Item>
        </PageRows>
      )}
    </ControlsSection>
  );
}
