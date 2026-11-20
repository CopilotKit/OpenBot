import { expect, test } from "bun:test";
import { toolName, toolSummary } from "@/lib/plugins/tool-words";

/**
 * The sentence an app's page shows under a tool in the personal edition, against descriptions as
 * Composio publishes them for Gmail, GitHub, HubSpot, Slack, Google Calendar and Notion. Each pair is
 * a real description and what a person reads.
 */
const READS: ReadonlyArray<readonly [string, string | null]> = [
  // "Tool to" goes, and the sentence says what the tool does.
  [
    "Tool to abort a repository migration that is queued or in progress.",
    "Aborts a repository migration that is queued or in progress.",
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
    "Creates a legacy email, call, meeting, task, or note engagement with optional CRM associations, attachments, and type-specific metadata.",
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
    "Finds Slack users by ID, email, name, display name, or other text.",
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
  // A command says what the tool does, past any adverbs, and so does a second one it goes on to.
  [
    "Apply draft changes to the live version of a HubSpot landing page.",
    "Applies draft changes to the live version of a HubSpot landing page.",
  ],
  [
    "Tool to batch-read CRM associations (e.g., deals→contacts, deals→companies) for up to 1,000 source record IDs in one request.",
    "Batch-reads CRM associations (e.g., deals→contacts, deals→companies) for up to 1,000 source record IDs in one request.",
  ],
  [
    "Sparse-update a HubSpot landing page and return its updated state.",
    "Sparse-updates a HubSpot landing page and returns its updated state.",
  ],
  [
    "Call this to mute a specific notification thread by deleting the user's subscription; notifications may still occur if the user is mentioned, comments, or due to repository watch settings.",
    "Mutes a specific notification thread by deleting the user's subscription.",
  ],
  ["Action to get an issue comment.", "Gets an issue comment."],
  [
    "_lists public gists for a specified GitHub user._",
    "Lists public gists for a specified GitHub user.",
  ],
  // Not a word that names a thing.
  [
    "Update page properties, icon, cover, or archive status.",
    "Updates page properties, icon, cover, or archive status.",
  ],
  [
    "Append to-do, toggle, and callout blocks to a Notion page or block that supports children.",
    "Appends to-do, toggle, and callout blocks to a Notion page or block that supports children.",
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

/**
 * A tool's name in a list of tools, against names as Composio publishes them for Gmail, GitHub,
 * HubSpot, Slack and Google Calendar, and OpenBot's own Routines. Each pair is the app and the stored
 * name, and what a person reads.
 */
const NAMED: ReadonlyArray<readonly [string, string, string]> = [
  // Names written in capitals, and "I".
  ["composio-gmail", "GMAIL_UPDATE_IMAP_SETTINGS", "Update IMAP settings"],
  ["composio-gmail", "GMAIL_LIST_CSE_IDENTITIES", "List CSE identities"],
  ["composio-gmail", "GMAIL_LIST_SMIME_INFO", "List S/MIME info"],
  ["composio-gmail", "GMAIL_WHO_AM_I", "Who am I"],
  ["composio-slack", "SLACK_OPEN_DM", "Open DM"],
  [
    "composio-hubspot",
    "HUBSPOT_CREATE_AB_TEST_VARIATION",
    "Create A/B test variation",
  ],
  ["composio-github", "GITHUB_RUN_GRAPH_QL_QUERY", "Run GraphQL query"],
  // A verb a stored name puts last comes first, and settings come after what they are for.
  ["composio-gmail", "GMAIL_SETTINGS_GET_IMAP", "Get IMAP settings"],
  ["composio-gmail", "GMAIL_SETTINGS_SEND_AS_GET", "Get send-as settings"],
  ["composio-googlecalendar", "GOOGLECALENDAR_ACL_DELETE", "Delete ACL"],
  [
    "composio-googlecalendar",
    "GOOGLECALENDAR_CALENDAR_LIST_GET",
    "Get calendar list",
  ],
  [
    "composio-googlecalendar",
    "GOOGLECALENDAR_SETTINGS_WATCH",
    "Watch settings",
  ],
  ["composio-slack", "SLACK_RTM_CONNECT", "Connect RTM"],
  ["composio-gmail", "GMAIL_STOP_WATCH", "Stop watching"],
  // Not a name that already reads as words, or a word that is the thing ("workflow run").
  ["composio-googlecalendar", "GOOGLECALENDAR_QUICK_ADD", "Quick add"],
  [
    "composio-github",
    "GITHUB_FORCE_CANCEL_WORKFLOW_RUN",
    "Force cancel workflow run",
  ],
  ["composio-github", "GITHUB_REREQUEST_A_CHECK_RUN", "Rerequest a check run"],
  ["composio-googledrive", "GOOGLEDRIVE_EMPTY_TRASH", "Empty trash"],
  ["composio-hubspot", "HUBSPOT_REMOVE_SETTINGS_USER", "Remove settings user"],
  // How it finds a thing by its ID goes, unless the ID is one of two ways.
  ["composio-gmail", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "Fetch message"],
  [
    "composio-gmail",
    "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
    "Fetch thread messages",
  ],
  ["composio-hubspot", "HUBSPOT_GET_CRM_LISTS_BY_IDS", "Get CRM lists"],
  [
    "composio-hubspot",
    "HUBSPOT_RETRIEVE_OWNER_BY_ID_OR_USER_ID",
    "Retrieve owner by ID or user ID",
  ],
  // OpenBot's own Routines, as a command like every other app's tool.
  ["routines", "complete_goal", "Complete goal"],
  ["routines", "create_goal", "Create goal"],
];

test("an app's tool is named as a person would name it in a list", () => {
  for (const [app, stored, reads] of NAMED) {
    expect({ stored, reads: toolName(app, stored) }).toEqual({ stored, reads });
  }
});
