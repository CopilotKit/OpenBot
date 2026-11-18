import { useQuery } from "@tanstack/react-query";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import { computerModeQueryOptions } from "@/lib/enterprise/queries";
import { cn } from "@/lib/utils";

/**
 * Said to an admin wherever Admin talks about computers: this OpenBot runs every person's Bots on
 * one computer, which is a proof-of-concept setup, and how to give each person their own.
 *
 * The server decides (the settings' `computerMode`): an OpenBot only one person uses, OpenBot
 * Desktop included, answers `per-person`, because that one computer is the person's own. Drawn only
 * for an admin, so nobody else asks for settings they can't read. Nothing while loading, on a
 * failed read, or from a server that does not say.
 */
export function SharedComputersNotice({ className }: { className?: string }) {
  const admin = isOrganizationAdmin(
    useQuery(currentUserQueryOptions()).data?.role,
  );
  const mode = useQuery({ ...computerModeQueryOptions(), enabled: admin });
  if (!admin || mode.data !== "shared") return null;
  return (
    <p
      className={cn(
        "rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm",
        className,
      )}
      data-shared-computers-notice=""
    >
      <span className="font-medium">Everyone's Bots share one computer.</span> A
      command one Bot runs can read another person's files there, so use this
      only for a proof of concept. To give each person a computer of their own,
      set <code>computers.mode: sandbox</code> in the Helm chart, or{" "}
      <code>COMPUTER_SUPERVISOR_URL</code> with Docker Compose.
    </p>
  );
}
