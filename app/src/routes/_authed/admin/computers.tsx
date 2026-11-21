import { createFileRoute } from "@tanstack/react-router";
import {
  InactiveComputersSection,
  NetworkSection,
} from "@/components/admin/controls/Computador-sections";
import { ComputersPage } from "@/components/Gerir/Computadores-page";
import { useNoBotComputers } from "@/lib/deployment/queries";

export const Route = createFileRoute("/_authed/admin/Computadores")({
  component: AdminComputersPage,
});

/**
 * The computers, then when idle ones stop and where they may connect.
 *
 * An OpenBot with no computers for Bots has none to stop, so the idle computers' controls are not
 * drawn there. Where a Bot's computer may connect is still an admin's to decide ahead of having one.
 */
function AdminComputersPage() {
  const noComputers = useNoBotComputers();
  return (
    <ComputersPage>
      {noComputers ? null : <InactiveComputersSection />}
      <NetworkSection />
    </ComputersPage>
  );
}
