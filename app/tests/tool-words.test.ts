import { expect, test } from "bun:test";
import { toolSummary } from "@/lib/plugins/tool-words";

/**
 * The sentence an app's page shows under a tool in the personal edition, against descriptions as
 * Composio publishes them for Gmail, GitHub, HubSpot, Slack, Google Calendar and Notion. Each pair is
 * a real description and what a person reads.
 */
const READS: ReadonlyArray<readonly [string, string | null]> = [
  // "Tool to" goes, and the verb after it opens the sentence.
  [
    "Tool to abort a repository migration that is queued or in progress.",
    "Abort a repository migration that is queued or in progress.",
  ],
  // A word in capitals is said in normal case, at the start of the sentence too.
  [
    "Accepts a PENDING repository invitation that has been issued to the authenticated user.",
    "Accepts a pending repository invitation that has been issued to the authenticated user.",
  ],
  [
    "IRREVERSIBLY opt out or update email subscription preferences in HubSpot.",
    "Irreversibly opt out or update email subscription preferences in HubSpot.",
  ],
  [
    "Create a legacy EMAIL, CALL, MEETING, TASK, or NOTE engagement with optional CRM associations, attachments, and type-specific metadata.",
    "Create a legacy email, call, meeting, task, or note engagement with optional CRM associations, attachments, and type-specific metadata.",
  ],
  // A label keeps its capital.
  [
    "Updates existing Notion block's text content. ⚠️ CRITICAL: Content limited to 2000 chars.",
    "Updates existing Notion block's text content. ⚠️ Critical: Content limited to 2000 chars.",
  ],
  // Names written in capitals stay as they are.
  [
    "Retrieves a repository's community profile metrics, including health percentage and the presence of key community files (e.g., README, LICENSE).",
    "Retrieves a repository's community profile metrics, including health percentage and the presence of key community files (e.g., README, LICENSE).",
  ],
  [
    "Retrieves the DNS health check status (e.g., CNAME/A records, HTTPS) for a GitHub Pages site.",
    "Retrieves the DNS health check status (e.g., CNAME/A records, HTTPS) for a GitHub Pages site.",
  ],
  // How it finds a thing by its ID goes, with the commas around it.
  [
    "Retrieves metadata for a SINGLE specific calendar from the user's calendar list by its calendar ID.",
    "Retrieves metadata for a single specific calendar from the user's calendar list.",
  ],
  [
    "Deletes a specific deployment branch or tag policy, identified by its ID, from a given environment within a repository.",
    "Deletes a specific deployment branch or tag policy from a given environment within a repository.",
  ],
  [
    "Updates the title, join URL, or desktop app join URL for an existing Slack call identified by its ID.",
    "Updates the title, join URL, or desktop app join URL for an existing Slack call.",
  ],
  [
    "Retrieves detailed information for an existing Slack reminder specified by its ID.",
    "Retrieves detailed information for an existing Slack reminder.",
  ],
  [
    "Retrieves a Gmail message attachment by message and attachment IDs and returns a downloadable file using the supplied filename.",
    "Retrieves a Gmail message attachment and returns a downloadable file using the supplied filename.",
  ],
  // Unless the ID is one of the things it finds by, which a person can give the others of.
  [
    "Find Slack users by ID, email, name, display name, or other text.",
    "Find Slack users by ID, email, name, display name, or other text.",
  ],
  [
    "Deletes a message, identified by its channel ID and timestamp, from a Slack channel, private group, or direct message conversation.",
    "Deletes a message, identified by its channel ID and timestamp, from a Slack channel, private group, or direct message conversation.",
  ],
  [
    "Retrieves a specific HubSpot CRM timeline event by its application ID, event template ID, and event ID, returning event details including timestamp, tokens, and associated object information.",
    "Retrieves a specific HubSpot CRM timeline event by its application ID, event template ID, and event ID, returning event details including timestamp, tokens, and associated object information.",
  ],
  [
    "Efficiently retrieves a batch of HubSpot CRM quotes by their IDs (or a specified unique property), optionally including archived quotes, specific properties, and property history.",
    "Efficiently retrieves a batch of HubSpot CRM quotes by their IDs (or a specified unique property), optionally including archived quotes, specific properties, and property history.",
  ],
  // Or where it orders or filters rather than finds.
  [
    "Lists GitHub organizations for the authenticated user, sorted by ID in ascending order.",
    "Lists GitHub organizations for the authenticated user, sorted by ID in ascending order.",
  ],
  [
    "Lists GitHub's global security advisories, filterable by ID, type, ecosystem, severity, dates, and other attributes.",
    "Lists GitHub's global security advisories, filterable by ID, type, ecosystem, severity, dates, and other attributes.",
  ],
  // A sentence that points the model at another tool by its name says nothing a person can use.
  ["DEPRECATED: Use CalendarListGet instead.", null],
  ["DEPRECATED: Use GetAboutUser instead.", null],
];

test("an app's tool reads as a person would say what it does", () => {
  for (const [description, reads] of READS) {
    expect({ description, reads: toolSummary(description) }).toEqual({
      description,
      reads,
    });
  }
});
