import { useNavigate, useRouter } from "@tanstack/react-router";
import { Fragment, type ReactNode, useEffect } from "react";
import {
  onOrganizationChange,
  useCurrentOrganizationId,
} from "@/lib/organizations/current";
import { onSwitchedElsewhere } from "@/lib/organizations/queries";

/**
 * Everything inside is built for the organization the person is working in.
 *
 * Keyed by it, so a switch takes every screen, dialog and running conversation of the organization
 * left off the page and builds them again for the new one. Nothing a component held (an open
 * conversation, a draft, a list it had drawn) is carried from one organization into another.
 *
 * It also says how a switch made in another window is followed here: from home.
 *
 * AND THE GATES DECIDE AGAIN, IN THE NEW ONE. A switch takes the person home while the app still
 * works in the organization they are leaving, so the signed-in gate (`_authed`) and onboarding's
 * decided on that one's answers. Once the app has changed over (and dropped what it held for the
 * old one, query-client.ts), the routes on screen load again, and their gates ask the new one:
 * somebody who has to connect their own AI there is sent to do it at once, not on their next click.
 */
export function OrganizationBoundary({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const router = useRouter();
  // A switch made in another window is followed from home, as a switch made here is.
  useEffect(
    () =>
      onSwitchedElsewhere(async () => {
        await navigate({ to: "/" });
      }),
    [navigate],
  );
  useEffect(
    () =>
      onOrganizationChange((next, previous) => {
        if (next === undefined || previous === undefined) return;
        void router.invalidate();
      }),
    [router],
  );
  return <Fragment key={useCurrentOrganizationId()}>{children}</Fragment>;
}
