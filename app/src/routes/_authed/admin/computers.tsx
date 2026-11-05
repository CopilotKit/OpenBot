import { createFileRoute } from "@tanstack/react-router";
import {
  InactiveComputersSection,
  NetworkSection,
} from "@/components/admin/controls/computer-sections";
import { ComputersPage } from "@/components/manage/computers-page";

export const Route = createFileRoute("/_authed/admin/computers")({
  component: AdminComputersPage,
});

/** The computers, then when idle ones stop and where they may connect. */
function AdminComputersPage() {
  return (
    <ComputersPage>
      <InactiveComputersSection />
      <NetworkSection />
    </ComputersPage>
  );
}
