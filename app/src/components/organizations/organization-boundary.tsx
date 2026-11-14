import { useNavigate } from "@tanstack/react-router";
import { Fragment, type ReactNode, useEffect } from "react";
import { useCurrentOrganizationId } from "@/lib/organizations/current";
import { onSwitchedElsewhere } from "@/lib/organizations/queries";

/**
 * Everything inside is built for the organization the person is working in.
 *
 * Keyed by it, so a switch takes every screen, dialog and running conversation of the organization
 * left off the page and builds them again for the new one. Nothing a component held (an open
 * conversation, a draft, a list it had drawn) is carried from one organization into another.
 *
 * It also says how a switch made in another window is followed here: from home.
 */
export function OrganizationBoundary({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  // A switch made in another window is followed from home, as a switch made here is.
  useEffect(
    () =>
      onSwitchedElsewhere(async () => {
        await navigate({ to: "/" });
      }),
    [navigate],
  );
  return <Fragment key={useCurrentOrganizationId()}>{children}</Fragment>;
}
