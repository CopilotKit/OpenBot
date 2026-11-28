/**
 * Managed updates' words and formats, shared by the Admin screen and Admin's rail and overview.
 */

/** The entry sentence, the same on the screen and on Admin's rail and overview (MANAGEMENT_ENTRY). */
export const MANAGEMENT_SENTENCE =
  "OpenBot by CopilotKit upgrades this OpenBot for you, in your own cluster.";

/** How to set up upgrades once the agent OpenBot's chart installs is connected (docs/managed-upgrades.md). */
export const UPGRADES_SETUP_URL =
  "https://github.com/CopilotKit/OpenBot/blob/main/docs/managed-upgrades.md";

/** The Helm command with one flag per line and backslash line endings: it reads by hand and still pastes. */
export function helmLines(command: string): string {
  return command.replace(/ (--?[a-z])/g, " \\\n  $1");
}

const WEEKDAYS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

/** "Tuesdays, 14:00 to 18:00 UTC", the way the default is said before Connect. */
export function windowText(window: {
  weekday: number;
  startUtc: string;
  hours: number;
}): string {
  const [hour = 0, minute = 0] = window.startUtc.split(":").map(Number);
  const startMinutes = hour * 60 + minute;
  const endMinutes = startMinutes + Math.round(window.hours * 60);
  const day = WEEKDAYS[window.weekday] ?? "";
  if (window.hours >= 24)
    return `${day} from ${window.startUtc} UTC, for ${window.hours} hours`;
  const end = `${String(Math.floor(endMinutes / 60) % 24).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
  return endMinutes >= 24 * 60
    ? `${day}, ${window.startUtc} UTC to ${end} UTC the next day`
    : `${day}, ${window.startUtc} to ${end} UTC`;
}
