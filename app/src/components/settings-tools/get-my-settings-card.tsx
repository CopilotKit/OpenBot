import { IconUserCircle } from "@tabler/icons-react";
import { ASK_FIRST_TITLE } from "@/components/approvals/ask-first-copy";
import { HOST_LABELS } from "@/components/approvals/rules";
import { Badge } from "@/components/gallery/frame";
import type { SettingsToolCardProps } from "./registry";
import {
  NotSet,
  SettingsReadCard,
  SettingsRow,
  SettingsSection,
} from "./settings-read-card";

/**
 * `get_my_settings`: the person's own settings, in the sections and words of their Settings screens
 * (General, Notifications, Approvals), with a link to them.
 */

type Output = {
  person?: { name?: string | null; email?: string; role?: string };
  standingInstructions?: string | null;
  preferences?: {
    checkIns?: string;
    conversationList?: string;
    skin?: string;
  } | null;
  notifications?: { kind?: string; reaches?: "everywhere" | string[] }[] | null;
  approvals?: {
    askBeforeChanges?: boolean;
    autoReview?: boolean;
    hostCommands?: string;
  } | null;
};

/** Where updates go, by kind, as the Notifications screen names them. */
const KINDS: Record<string, string> = {
  progress: "Progress",
  decision: "Decisions",
  question: "Questions",
  attention: "Something needs you",
};

/** Ways to be reached, as the Notifications screen names them. */
const TRANSPORTS: Record<string, string> = {
  push: "Push",
  slack: "Slack",
  teams: "Microsoft Teams",
  telegram: "Telegram",
  sms: "SMS",
};
const TRANSPORT_ORDER = Object.keys(TRANSPORTS);

const SKINS: Record<string, string> = {
  openbot: "OpenBot",
  openduet: "OpenDuet",
  opendots: "OpenDots",
  openfuse: "OpenFuse",
};

const ROLES: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

const onOff = (value: boolean | undefined) => (value ? "On" : "Off");

export function GetMySettingsCard({
  output,
  state,
  reason,
}: SettingsToolCardProps) {
  const settings = (output ?? {}) as Output;
  const person = settings.person;
  return (
    <SettingsReadCard
      caption="What your Bots see when they work for you."
      icon={IconUserCircle}
      link={{ to: "/settings", label: "Open Settings" }}
      state={state}
      title="Your settings"
      {...(reason ? { reason } : {})}
    >
      <SettingsSection title="About you">
        <SettingsRow label="Name">
          {person?.name ? person.name : <NotSet />}
        </SettingsRow>
        <SettingsRow label="Email">{person?.email ?? <NotSet />}</SettingsRow>
        {person?.role ? (
          <SettingsRow label="Role">
            <Badge>{ROLES[person.role] ?? person.role}</Badge>
          </SettingsRow>
        ) : null}
        {settings.standingInstructions !== null &&
        settings.standingInstructions !== undefined ? (
          <SettingsRow label="Standing instructions" stacked>
            {settings.standingInstructions ? (
              <span className="line-clamp-6">
                {settings.standingInstructions}
              </span>
            ) : (
              <NotSet>None yet</NotSet>
            )}
          </SettingsRow>
        ) : null}
      </SettingsSection>
      {settings.preferences ? (
        <SettingsSection title="Preferences">
          <SettingsRow label="Check-ins from all your Bots">
            {settings.preferences.checkIns === "off" ? "Off" : "On"}
          </SettingsRow>
          {settings.preferences.skin ? (
            <SettingsRow label="Skin">
              {SKINS[settings.preferences.skin] ?? settings.preferences.skin}
            </SettingsRow>
          ) : null}
        </SettingsSection>
      ) : null}
      {settings.notifications && settings.notifications.length > 0 ? (
        <SettingsSection title="Where updates go">
          {settings.notifications.map((one) => (
            <SettingsRow
              key={one.kind}
              label={KINDS[one.kind ?? ""] ?? one.kind ?? ""}
            >
              {one.reaches === "everywhere" || one.reaches === undefined ? (
                "Every way you can be reached"
              ) : one.reaches.length === 0 ? (
                <NotSet>Only in OpenBot</NotSet>
              ) : (
                // In the Notifications screen's order: Push, Slack, Microsoft Teams, Telegram, SMS.
                [...one.reaches]
                  .sort(
                    (a, b) =>
                      TRANSPORT_ORDER.indexOf(a) - TRANSPORT_ORDER.indexOf(b),
                  )
                  .map((way) => TRANSPORTS[way] ?? way)
                  .join(", ")
              )}
            </SettingsRow>
          ))}
        </SettingsSection>
      ) : null}
      {settings.approvals ? (
        <SettingsSection title="Before a Bot acts">
          <SettingsRow label={ASK_FIRST_TITLE}>
            {onOff(settings.approvals.askBeforeChanges)}
          </SettingsRow>
          <SettingsRow label="Auto-review">
            {onOff(settings.approvals.autoReview)}
          </SettingsRow>
          {settings.approvals.hostCommands ? (
            <SettingsRow label="Commands on your computer">
              {HOST_LABELS[
                settings.approvals.hostCommands as keyof typeof HOST_LABELS
              ] ?? settings.approvals.hostCommands}
            </SettingsRow>
          ) : null}
        </SettingsSection>
      ) : null}
    </SettingsReadCard>
  );
}
