import { Fragment, type ReactNode } from "react";
import { useCurrentOrganizationId } from "@/lib/organizations/current";

/**
 * Everything inside is built for the organization the person is working in.
 *
 * Keyed by it, so a switch takes every screen, dialog and running conversation of the organization
 * left off the page and builds them again for the new one. Nothing a component held (an open
 * conversation, a draft, a list it had drawn) is carried from one organization into another.
 */
export function OrganizationBoundary({ children }: { children: ReactNode }) {
  return <Fragment key={useCurrentOrganizationId()}>{children}</Fragment>;
}
