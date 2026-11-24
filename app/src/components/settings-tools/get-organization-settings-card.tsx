import { IconBuilding } from "@tabler/icons-react";
import { HOST_LABELS } from "@/components/approvals/rules";
import type { SettingsToolCardProps } from "./registry";
import {
  NotSet,
  SettingsReadCard,
  SettingsRow,
  SettingsSection,
} from "./settings-read-card";

/**
 * `get_organization_settings`, for an admin: the organization's settings, each permission for
 * everyone, and its approval settings, in Admin's words, opening Admin.
 */

type Output = {
  organization?: { name?: string | null };
  settings?: {
    ssoRequired?: boolean;
    actionRecording?: boolean;
    inactiveComputerDays?: number;
    skillSharing?: boolean;
    checkInsPerDay?: number;
    modelAllowlist?: { enabled?: boolean; models?: string[] };
    appAllowlist?: { enabled?: boolean; apps?: string[] };
  };
  permissions?: {
    id?: string;
    title?: string;
    default?: boolean;
    forEveryone?: boolean | null;
    overrides?: number;
  }[];
  approvals?: {
    autoReviewEnforced?: boolean;
    personalRulesAllowed?: boolean;
    hostCommandsCap?: string;
    closedKinds?: { kind?: string; policy?: string }[];
  } | null;
};

const onOff = (value: boolean | undefined) => (value ? "On" : "Off");

/** An allowlist as its Admin page says it: off, or on and the names it lets through. */
function allowlist(list: { enabled?: boolean; items?: string[] } | undefined) {
  if (!list?.enabled) return "Off";
  const items = list.items ?? [];
  if (items.length === 0) return "On. None allowed yet.";
  const shown = items.slice(0, 4).join(", ");
  return `On: ${items.length > 4 ? `${shown} and ${items.length - 4} more` : shown}`;
}

/** Each kind of action and what it does, in Admin → Approvals' words (team-settings.tsx). */
const KIND_NAMES: Record<string, string> = {
  sending: "Sending to other people",
  deleting: "Deleting",
  sharing: "Sharing",
  publishing: "Posting and publishing",
  payments: "Paying and buying",
  security_settings: "Security and access settings",
  credentials: "Passwords and sign-in details",
};
const POLICY_NAMES: Record<string, string> = {
  ask: "Ask every time",
  hand_off: "Members do it themselves",
};

export function GetOrganizationSettingsCard({
  output,
  state,
  reason,
}: SettingsToolCardProps) {
  const read = (output ?? {}) as Output;
  const settings = read.settings ?? {};
  const permissions = (read.permissions ?? []).filter(
    (one): one is typeof one & { id: string; title: string } =>
      typeof one.id === "string" && typeof one.title === "string",
  );
  return (
    <SettingsReadCard
      caption={
        read.organization?.name
          ? `${read.organization.name}, for everyone in it.`
          : "For everyone in your organization."
      }
      icon={IconBuilding}
      link={{ to: "/admin", label: "Open Admin" }}
      state={state}
      title="Organization settings"
      {...(reason ? { reason } : {})}
    >
      <SettingsSection title="Settings">
        <SettingsRow label="Require SSO">
          {onOff(settings.ssoRequired)}
        </SettingsRow>
        <SettingsRow label="Action recording">
          {onOff(settings.actionRecording)}
        </SettingsRow>
        <SettingsRow label="Skill sharing">
          {onOff(settings.skillSharing)}
        </SettingsRow>
        {typeof settings.checkInsPerDay === "number" ? (
          <SettingsRow label="Check-ins daily limit">
            {`Up to ${settings.checkInsPerDay} a day per Bot for each person`}
          </SettingsRow>
        ) : null}
        {typeof settings.inactiveComputerDays === "number" ? (
          <SettingsRow label="Stop inactive computers">
            {settings.inactiveComputerDays === 0 ? (
              <NotSet>Never</NotSet>
            ) : (
              `After ${settings.inactiveComputerDays} ${settings.inactiveComputerDays === 1 ? "day" : "days"} without use`
            )}
          </SettingsRow>
        ) : null}
        <SettingsRow label="Only allowed models">
          {allowlist({
            ...(settings.modelAllowlist?.enabled !== undefined
              ? { enabled: settings.modelAllowlist.enabled }
              : {}),
            ...(settings.modelAllowlist?.models
              ? { items: settings.modelAllowlist.models }
              : {}),
          })}
        </SettingsRow>
        <SettingsRow label="Only approved connectors">
          {allowlist({
            ...(settings.appAllowlist?.enabled !== undefined
              ? { enabled: settings.appAllowlist.enabled }
              : {}),
            ...(settings.appAllowlist?.apps
              ? { items: settings.appAllowlist.apps }
              : {}),
          })}
        </SettingsRow>
      </SettingsSection>
      {permissions.length > 0 ? (
        <SettingsSection title="Permissions">
          {permissions.map((one) => {
            const on = one.forEveryone ?? one.default ?? false;
            return (
              <SettingsRow key={one.id} label={one.title}>
                {onOff(on)}
                {one.overrides ? (
                  <span className="text-muted-foreground">
                    {`, ${one.overrides} ${one.overrides === 1 ? "override" : "overrides"}`}
                  </span>
                ) : null}
              </SettingsRow>
            );
          })}
        </SettingsSection>
      ) : null}
      {read.approvals ? (
        <SettingsSection title="Approvals">
          <SettingsRow label="Require auto-review for everyone">
            {onOff(read.approvals.autoReviewEnforced)}
          </SettingsRow>
          <SettingsRow label="Let members set personal rules">
            {onOff(read.approvals.personalRulesAllowed)}
          </SettingsRow>
          {read.approvals.hostCommandsCap ? (
            <SettingsRow label="Commands on members' computers, at most">
              {HOST_LABELS[
                read.approvals.hostCommandsCap as keyof typeof HOST_LABELS
              ] ?? read.approvals.hostCommandsCap}
            </SettingsRow>
          ) : null}
          {(read.approvals.closedKinds ?? []).map((closed) => (
            <SettingsRow
              key={closed.kind}
              label={KIND_NAMES[closed.kind ?? ""] ?? closed.kind ?? ""}
            >
              {POLICY_NAMES[closed.policy ?? ""] ?? closed.policy}
            </SettingsRow>
          ))}
        </SettingsSection>
      ) : null}
    </SettingsReadCard>
  );
}
