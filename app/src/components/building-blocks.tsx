import {
  IconChevronRight,
  IconComponents,
  IconForms,
  IconLayout,
  IconPhoto,
  IconStack2,
  IconTable,
  IconTypography,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import type { ComponentRecord } from "@/lib/components/queries";
import {
  isStandardUiComponentName,
  STANDARD_UI_GROUPS,
  type StandardUiGroup,
} from "@openbot/shared/standard-ui";

const GROUP_ICONS: Record<StandardUiGroup, ReactNode> = {
  layout: <IconLayout />,
  text: <IconTypography />,
  inputs: <IconForms />,
  data: <IconTable />,
  media: <IconPhoto />,
  feedback: <IconStack2 />,
  composites: <IconComponents />,
};

/** The gallery's own components first, the standard catalog's families second. */
export function splitBuildingBlocks<T extends { name: string }>(
  components: readonly T[],
) {
  return {
    gallery: components.filter(
      (component) => !isStandardUiComponentName(component.name),
    ),
    blocks: components.filter((component) =>
      isStandardUiComponentName(component.name),
    ),
  };
}

/** Where a family stands, in the words of the Available to row on its own page. */
export function blockAvailability(component: ComponentRecord) {
  if (!component.published) return "Off";
  const withheld = component.withheldFrom.length;
  if (withheld === 0) return "On for every Bot";
  return `Off for ${withheld} ${withheld === 1 ? "Bot" : "Bots"}`;
}

/**
 * The standard catalog's families, one section per group, one row per family.
 *
 * Rows rather than the gallery's tiles: there are dozens of them, and a Bot arranges them into an
 * interface of its own, so a tile showing one on its own says little.
 */
export function BuildingBlockSections({
  components,
  linkTo,
}: {
  components: readonly ComponentRecord[];
  /** Where a row opens: the family's governance in Admin, or its preview in the people's gallery. */
  linkTo: "/admin/components/$name" | "/settings/components-gallery/$name";
}) {
  const groups = (Object.keys(STANDARD_UI_GROUPS) as StandardUiGroup[])
    .map((group) => ({
      group,
      rows: components.filter((component) => component.kind === group),
    }))
    .filter(({ rows }) => rows.length > 0);

  return groups.map(({ group, rows }) => (
    <PageSection key={group} title={STANDARD_UI_GROUPS[group].title}>
      <PageRows>
        {rows.map((component, index) => (
          <Fragment key={component.name}>
            {index > 0 ? <Separator /> : null}
            <Item
              data-testid={`block-${component.name}`}
              render={<Link params={{ name: component.name }} to={linkTo} />}
              size="sm"
            >
              <ItemMedia variant="icon">{GROUP_ICONS[group]}</ItemMedia>
              <ItemContent>
                <ItemTitle>{component.title}</ItemTitle>
                <ItemDescription>
                  {linkTo === "/admin/components/$name"
                    ? blockAvailability(component)
                    : component.publishedDescription}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </Fragment>
        ))}
      </PageRows>
    </PageSection>
  ));
}
