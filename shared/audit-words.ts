import { appToolName, connectorName, humanise } from "./tool-name";
import { lowerFirst } from "./tool-name-words";

/**
 * What an Activity or Audit row is about, in words: the What column, where the trail's own names
 * (`mcp.tools_discovered`, `computer_write_file`) used to show as they are stored.
 *
 * Every phrase is what was asked for, not what came of it ("Save a file", not "Saved a file"),
 * because the Decision beside it says what came of it, and an action that was blocked or failed
 * must not read as done. That is why a computer's actions have their own words here rather than
 * the conversation's past-tense step labels. An app's tool keeps the words a conversation gives it
 * (`appToolName`), which are already the action itself.
 *
 * The stored names are not lost: the CSV export carries them unchanged, the search box finds a row
 * by them, and Admin shows one on hover.
 */

/** A computer's or this computer's actions, by the tool name an action row records. */
const ACTIONS: Readonly<Record<string, string>> = {
  computer_navigate: "Open a page",
  computer_read: "Read a page",
  computer_snapshot: "Inspect a page",
  computer_click: "Click on a page",
  computer_type: "Fill in a field",
  computer_key: "Press a key",
  computer_scroll: "Scroll a page",
  computer_screenshot: "Take a screenshot",
  computer_list_files: "List files",
  computer_read_file: "Read a file",
  computer_write_file: "Save a file",
  computer_run_command: "Run a command",
  computer_download_file: "Download a file",
  computer_handoff: "Hand the computer to a person",
  computer_request_help: "Ask a person for help",
  computer_request_secret: "Ask a person to fill in a field",
  computer_request_sign_in: "Ask a person to sign in",
  host_list_folders: "Check your folders",
  host_list_files: "List files",
  host_read_file: "Read a file",
  host_write_file: "Save a file",
  host_run_command: "Run a command",
  "bot/message_bot": "Ask another Bot",
  "openbot/share_private_information": "Share private information",
};

/**
 * Every event the trail records, by the type it is stored under. `server/tests/audit-words.test.ts`
 * fails on a type the server registers without words here, so a new one cannot reach the screen as
 * its stored name.
 */
export const AUDIT_EVENT_WORDS: Readonly<Record<string, string>> = {
  "configuration.changed": "Change a setting",
  "credential.created": "Save a credential",
  "credential.rotated": "Replace a credential",
  "credential.rotation_refused": "Replace a credential",
  "credential.revoked": "Remove a credential",
  "channel.routed": "Choose a Bot for a message",
  "channel.deleted": "Delete a conversation",
  "delivery.received": "Receive a message",
  "delivery.sent": "Send a message",
  "delivery.opted_out": "Stop receiving messages",
  "delivery.failed": "Send a message",
  "delivery.linked": "Connect a messaging app",
  "delivery.unlinked": "Disconnect a messaging app",
  "agent.dial_refused": "Reach a Bot",
  "agent.stream_stalled": "Reply",
  "agent.tool_limit_refused": "Start a reply",
  "agent.handoff_offered": "Hand work to another Bot",
  "agent.handoff_refused": "Hand work to another Bot",
  "agent.handoff_delivered": "Hand work to another Bot",
  "agent.handoff_failed": "Hand work to another Bot",
  "agent.handoff_retried": "Hand work to another Bot",
  "agent.escalated": "Pass work to a person",
  "agent.escalation_failed": "Pass work to a person",
  "mcp.tools_discovered": "Choose tools for a run",
  "mcp.call_succeeded": "Use an app",
  "mcp.call_rejected": "Use an app",
  "mcp.call_failed": "Use an app",
  "mcp.callback_refused": "Use an app",
  // Said as what it is for: an app's sign-in, set up or read back. Admin hovers for the stored name.
  "mcp.oauth_client_registered": "Set up an app's sign-in",
  "mcp.oauth_client_read_failed": "Check an app's sign-in",
  "mcp.connection_verified": "Check a connection",
  "mcp.account_connected": "Connect an account",
  "mcp.authorization_unreconciled": "Finish connecting an account",
  "mcp.account_disconnected": "Disconnect an account",
  "mcp.authorization_cancelled": "Cancel connecting an account",
  "mcp.cancelled_grant_left_live": "Cancel connecting an account",
  "mcp.account_mode_changed": "Change whose account an app uses",
  "shared_use.requested": "Ask to use a shared account",
  "shared_use.approved": "Approve a shared account",
  "shared_use.declined": "Decline a shared account",
  "shared_use.owner_approved": "Approve a shared account",
  "shared_use.owner_withdrawn": "Withdraw a shared account",
  "app_access.requested": "Ask for an app",
  "app_access.cancelled": "Cancel a request for an app",
  "app_access.approved": "Approve a request for an app",
  "app_access.dismissed": "Dismiss a request for an app",
  "app_access.refused": "Ask for an app",
  "app_access.owner_granted": "Share an app",
  "app_access.owner_revoked": "Stop sharing an app",
  "plugin.grants_translated": "Choose a Bot's actions from a description",
  "plugin.grants_changed": "Change a Bot's actions in an app",
  "computer.action_allowed": "Use the computer",
  "computer.action_refused": "Use the computer",
  "computer.action_failed": "Use the computer",
  "computer.action_stopped": "Use the computer",
  "computer.help_requested": "Ask a person for help",
  "computer.help_cancelled": "Cancel a request for help",
  "computer.control_taken": "Take control of the computer",
  "computer.control_released": "Hand the computer back",
  "computer.secret_requested": "Ask a person to fill in a field",
  "computer.secret_supplied": "Fill in a field for a Bot",
  "computer.sign_in_requested": "Ask a person to sign in",
  "computer.sign_in_code_requested": "Ask for a sign-in code",
  "computer.sign_in_completed": "Sign in on the computer",
  "computer.sign_in_failed": "Sign in on the computer",
  "computer.sign_in_cancelled": "Cancel a sign-in",
  "computer.stopped": "Stop the computer",
  "computer.reset": "Reset the computer",
  "computer.browser_cleared": "Clear the browser",
  "computer.updated": "Update the computer",
  "computer.policy_loaded": "Start the computer",
  "computer.policy_changed": "Change the boundaries",
  "computer.policy_translated": "Write a boundary from a description",
  "computer.isolation_loaded": "Start the computer",
  "computer.terminated": "Shut down a computer",
  "computer.terminated_inactive": "Shut down an idle computer",
  "password.saved": "Save a login",
  "password.deleted": "Delete a login",
  "bot.declined": "Decline a request",
  "bot.created": "Create a Bot",
  "bot.updated": "Change a Bot",
  "bot.duplicated": "Duplicate a Bot",
  "bot.hidden": "Hide a Bot",
  "bot.unhidden": "Show a Bot",
  "bot.pinned": "Pin a Bot",
  "bot.unpinned": "Unpin a Bot",
  "bot.deleted": "Delete a Bot",
  "bot.callback_token_issued": "Issue a Bot's callback token",
  "bot.callback_token_revoked": "Revoke a Bot's callback token",
  "bot.isolation_refused": "Give a Bot its own computer",
  "bot.paused": "Pause a Bot",
  "bot.resumed": "Resume a Bot",
  "bot.reset": "Reset a Bot",
  "bot.notifications_changed": "Change a Bot's notifications",
  "bot.follow_up_scheduled": "Schedule a follow-up",
  "bot.follow_up_cancelled": "Cancel a follow-up",
  "bot.handoff_stopped": "Stop handing work on",
  "component.granted": "Give a component to a Bot",
  "component.revoked": "Take a component from a Bot",
  "component.published": "Publish a component",
  "component.unpublished": "Unpublish a component",
  "component.draft_saved": "Save a component draft",
  "component.description_updated": "Update a component's description",
  "component.refused": "Show a component",
  "component.function_granted": "Let a component read data",
  "component.function_revoked": "Stop a component reading data",
  "component.function_called": "Read data for a component",
  "component.function_refused": "Read data for a component",
  "component.function_failed": "Read data for a component",
  "person.role_changed": "Change a person's role",
  "person.access_revoked": "Remove a person's access",
  "person.access_restored": "Restore a person's access",
  "person.admin_by_configuration": "Make a person an admin",
  "person.provisioned": "Add a person",
  "person.deprovisioned": "Remove a person",
  "person.reprovisioned": "Add a person back",
  "audit.exported": "Export events",
  "audit.asked": "Ask the audit trail",
  "what_if.asked": "Ask what would happen",
  "what_if.checked": "Check what would happen",
  "session.signed_in": "Sign in",
  "session.refused": "Sign in",
  "session.break_glass": "Use emergency sign-in",
  "auth.sessions_revoked": "Sign a person out everywhere",
  "identity_provider.registered": "Add an identity provider",
  "identity_provider.removed": "Remove an identity provider",
  "identity.linked": "Link an account",
  "identity.unlinked": "Unlink an account",
  "identity.link_retired": "Retire a linked account",
  "routines.dispatch_refused": "Run a routine",
  "routines.run_requested": "Run a routine",
  "routine.created": "Create a routine",
  "routine.updated": "Change a routine",
  "routine.deleted": "Delete a routine",
  "routine.enabled_changed": "Turn a routine on or off",
  "responsibility.triggered": "Work on a goal",
  "approval.evaluated": "Check an action",
  "approval.person_decided": "Decide on an action",
  "approval.withdrawn": "Withdraw a request",
  "approval.rule_changed": "Change an approval rule",
  "approval.rules_translated": "Write approval rules from a description",
  "approval.guidance_changed": "Change guidance for auto-review",
  "approval.settings_changed": "Change approval settings",
  "capability.changed": "Change a permission",
  "capability.changes_translated":
    "Write permission changes from a description",
  "enterprise.setting_changed": "Change an organization setting",
  "network_policy.changed": "Change the network policy",
  "network_policy.removed": "Remove a network policy",
  "network_policy.translated": "Write a network allowlist from a description",
  "model.refused": "Use a model",
  "recorder.bearer_refused": "Use the Recorder",
  "recorder.connected": "Connect the Recorder",
  "recorder.connect_refused": "Connect the Recorder",
  "recorder.revoked": "Disconnect the Recorder",
  "recorder.sign_out_failed": "Sign the Recorder out",
  "recorder.trajectory_refused": "Save a recording",
  "learning.sharing_changed": "Change what is shared for learning",
  "learning.skill_opened": "Open a skill for review",
  "learning.skill_closed": "Close a skill review",
  "learning.sharing_requested": "Ask to share a learned skill",
  "learning.sharing_decided": "Answer a request to share a learned skill",
};

/**
 * An action as a row names it: a computer's or this computer's (`computer_write_file`,
 * `host/write_file`, the bare `click` one older row records), an app's tool (`gmail/send_email`),
 * one of OpenBot's own (`bot/message_bot`), or an app's whole account (`gmail/*`). A name this has
 * no words for is split into words, never shown as stored.
 */
export function auditActionWords(action: string): string {
  const known = [
    action,
    action.replace(/^host\//, "host_"),
    `computer_${action}`,
  ].find((name) => Object.hasOwn(ACTIONS, name));
  if (known && ACTIONS[known]) return ACTIONS[known];
  const slash = action.indexOf("/");
  const app = action.slice(0, slash);
  const tool = action.slice(slash + 1);
  if (slash <= 0 || !tool)
    return humanise(action.replace(/^(computer|host)_/, ""));
  return tool === "*"
    ? `Use ${connectorName(app)}`
    : appToolName(app, tool).label;
}

/**
 * A configuration row's change in words, read from the `change` its payload names: the plugin
 * store's own changes, which OpenBot makes by itself as well as a person does (it gives every Bot
 * Routines' tools at every start, and in the personal edition every app's tools). Any other change
 * answers nothing, and the row keeps "Change a setting".
 */
export function auditChangeWords(
  payload: Record<string, unknown>,
): string | undefined {
  const { change, kind } = payload;
  if (change === "plugin_granted") {
    if (kind === "skill") return "Give a Bot a skill";
    if (kind === "bot") return "Let a Bot ask another Bot";
    // One row names every tool a Bot was given at once; see `grantTools` on the server.
    return Array.isArray(payload.refs) && payload.refs.length > 1
      ? "Give a Bot tools"
      : "Give a Bot a tool";
  }
  if (change === "plugin_revoked") {
    if (kind === "skill") return "Take a skill from a Bot";
    if (kind === "bot") return "Stop a Bot asking another Bot";
    return "Take a tool from a Bot";
  }
  return typeof change === "string" && Object.hasOwn(CHANGES, change)
    ? CHANGES[change]
    : undefined;
}

const CHANGES: Readonly<Record<string, string>> = {
  mcp_server_added: "Turn on an app",
  mcp_server_removed: "Turn off an app",
  skill_installed: "Save a skill",
  skill_uninstalled: "Delete a skill",
  // A person's folders on their own computer, from Settings > Computer; see host-access/routes.ts.
  host_folder_granted: "Give a Bot a folder",
  host_folder_revoked: "Take a folder from a Bot",
  host_access_stopped: "Stop folder access",
  // OpenBot choosing the Learning space every Bot learns into, at its first start.
  default_container_assigned_automatically: "Set up Learning",
};

/**
 * What each of a component's data functions reads, in a person's words. `server/tests/audit-words.test.ts`
 * fails on a function the server ships without words here.
 */
export const DATA_FUNCTION_WORDS: Readonly<Record<string, string>> = {
  botActivity: "your Bots' activity",
  recentRefusals: "what was refused",
};

/**
 * The data a component was given or read, in words: "your Bots' activity and what was refused".
 * A function with no words of its own is split into words, never shown as stored.
 */
export function dataWords(functions: readonly string[]): string {
  const words = functions.map((name) =>
    Object.hasOwn(DATA_FUNCTION_WORDS, name)
      ? (DATA_FUNCTION_WORDS[name] as string)
      : humanise(name).toLowerCase(),
  );
  return words.length > 1
    ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`
    : (words[0] ?? "");
}

/** How many of an app's tools a row names one by one before it says how many more. */
const TOOLS_NAMED = 2;

/**
 * An app's tools, by their `app/tool` refs, in words with the app: "Send email on Gmail", "Create
 * goal, list goals and 5 more on Routines". What a row gave or took, for a page anybody
 * can open, where the refs themselves are never shown.
 */
export function appToolsWords(refs: readonly string[]): string {
  const first = refs[0] ?? "";
  const app = first.slice(0, Math.max(first.indexOf("/"), 0)) || first;
  const named = refs
    .slice(0, refs.length > TOOLS_NAMED + 1 ? TOOLS_NAMED : refs.length)
    .map((ref, index) => {
      const words = auditActionWords(ref);
      return index === 0 ? words : lowerFirst(words);
    });
  const more = refs.length - named.length;
  const list =
    more > 0
      ? `${named.join(", ")} and ${more} more`
      : named.length > 1
        ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`
        : (named[0] ?? "");
  return `${list} on ${connectorName(app)}`;
}

/**
 * An event in words: its own entry above, or, for a type older rows carry that no longer has one,
 * its stored name split into words. Never the stored name as it is.
 */
export function auditEventWords(eventType: string): string {
  return Object.hasOwn(AUDIT_EVENT_WORDS, eventType)
    ? (AUDIT_EVENT_WORDS[eventType] as string)
    : humanise(
        eventType
          .replace(/^mcp\./, "app.")
          .replace(/^agent\./, "bot.")
          .replace(/\./g, " "),
      );
}

/**
 * The rows an admin filters for most often, in the words the Audit page's views use: "Computer
 * actions" and "App calls", then how they ended. The event words above say what a
 * row was for a person reading one row ("Use the computer"); a filter is about a kind of row.
 */
const TYPE_WORDS: Record<string, string> = {
  "computer.action_allowed": "Computer actions, allowed",
  "computer.action_refused": "Computer actions, blocked",
  "computer.action_failed": "Computer actions, failed",
  "computer.action_stopped": "Computer actions, stopped",
  "mcp.call_succeeded": "App calls, done",
  "mcp.call_rejected": "App calls, blocked",
  "mcp.call_failed": "App calls, failed",
};

/** One event type as a filter names it: a kind of row, then how it ended where that matters. */
export function auditTypeWords(type: string): string {
  return TYPE_WORDS[type] ?? auditEventWords(type);
}
