import { useMutation, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { PageSection } from "@/components/layout/page-shell";
import {
  setCapabilityMutationOptions,
  setEnterpriseSettingMutationOptions,
} from "@/lib/enterprise/mutations";
import {
  type CapabilityKey,
  type EnterpriseOverview,
  type EnterpriseSettings,
  enterpriseOverviewQueryOptions,
} from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";

/** What a section of the admin's controls reads and changes. */
export type Controls = {
  data: EnterpriseOverview;
  setSetting: <K extends keyof EnterpriseSettings>(
    key: K,
    value: EnterpriseSettings[K],
  ) => void;
  /** At the organization's scope. Roles and groups are set in the overrides dialog. */
  setCapability: (capability: CapabilityKey, allowed: boolean) => void;
  saving: boolean;
};

/**
 * One section of the controls that apply to everybody, drawn on the admin page it is about.
 *
 * WHY EACH SECTION LOADS ITS OWN. These used to be one page, Enterprise controls, which held eight
 * unrelated decisions under a name that said nothing about any of them. Each now sits beside the
 * page it governs: the network policy on Computers, the MCP allowlist on Plugins, Action Recording
 * on Audit. They all read the one overview query, so a page with two of them still asks once, and
 * each keeps its own save state so a refused change is reported where it was made.
 */
export function ControlsSection({
  title,
  description,
  children,
}: {
  /** Absent on a page whose only section this is: the page title already names it. */
  title?: string;
  description?: ReactNode | ((data: EnterpriseOverview) => ReactNode);
  children: (controls: Controls) => ReactNode;
}) {
  const overview = useQuery(enterpriseOverviewQueryOptions());
  const setCapability = useMutation(setCapabilityMutationOptions(queryClient));
  const setSetting = useMutation(
    setEnterpriseSettingMutationOptions(queryClient),
  );
  if (overview.isPending) return null;
  /*
   * These sections sit on pages with work of their own (Plugins, Audit, Computers), so one that
   * cannot read its settings says so in place. An answer without settings is treated the same,
   * rather than taking the page it sits on down with it.
   */
  if (overview.error || !overview.data?.settings)
    return (
      <PageSection title={title}>
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't load these settings. Reload the page.
        </p>
      </PageSection>
    );
  const failure = setCapability.error ?? setSetting.error;
  return (
    <PageSection
      description={
        typeof description === "function"
          ? description(overview.data)
          : description
      }
      title={title}
    >
      {failure ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : null}
      {children({
        data: overview.data,
        setSetting: (key, value) => setSetting.mutate({ key, value }),
        setCapability: (capability, allowed) =>
          setCapability.mutate({
            scopeKind: "organization",
            scopeId: "",
            capability,
            allowed,
          }),
        saving: setCapability.isPending || setSetting.isPending,
      })}
    </PageSection>
  );
}
