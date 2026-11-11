import type { ResponsibilityRecord } from "@/lib/responsibilities";

type Source = ResponsibilityRecord["subscriptions"][number]["source"];

/** Each source by the name a person knows it by. */
export const EVENT_SOURCE_LABEL: Record<Source, string> = {
  manual: "Manual",
  slack: "Slack",
  github: "GitHub",
  schedule: "Schedule",
  connector: "Connected app",
  webhook: "Webhook",
  linear: "Linear",
  sentry: "Sentry",
  pagerduty: "PagerDuty",
  email: "Email",
};

/**
 * The events OpenBot is sent, by source and identifier, as a person would say them.
 *
 * The identifiers are the ones each source's webhook produces (`server/src/responsibilities`):
 * GitHub's `X-GitHub-Event` and the payload's `action` (`issues.opened`), Linear's entity and action
 * (`Issue.create`), Sentry's resource and action (`issue.created`), PagerDuty's `event_type`
 * (`incident.triggered`), Slack's event type, and an email's `received`. Only what the identifier
 * says: a finished check is not a passing one, and no repository is named from it.
 *
 * A new event a Bot is likely to subscribe to belongs here. One that isn't falls back to "When a
 * GitHub event arrives", with the identifier kept in the goal's details.
 */
const KNOWN: Partial<Record<Source, Record<string, string>>> = {
  github: {
    "check_run.completed": "When a GitHub check finishes",
    "check_suite.completed": "When GitHub checks finish",
    "workflow_run.completed": "When a GitHub workflow run finishes",
    "issues.opened": "When a GitHub issue opens",
    "issues.closed": "When a GitHub issue closes",
    "issues.reopened": "When a GitHub issue reopens",
    "issues.labeled": "When a GitHub issue is labeled",
    "issues.assigned": "When a GitHub issue is assigned",
    "issue_comment.created": "When someone comments on GitHub",
    "pull_request.opened": "When a GitHub pull request opens",
    "pull_request.closed": "When a GitHub pull request closes",
    "pull_request.reopened": "When a GitHub pull request reopens",
    "pull_request.ready_for_review":
      "When a GitHub pull request is ready for review",
    "pull_request.review_requested": "When someone asks for a GitHub review",
    "pull_request_review.submitted":
      "When someone reviews a GitHub pull request",
    push: "When someone pushes to GitHub",
    "release.published": "When a GitHub release is published",
  },
  slack: {
    message: "When a Slack message arrives",
    app_mention: "When someone mentions the Bot in Slack",
    reaction_added: "When someone reacts in Slack",
  },
  linear: {
    "Issue.create": "When a Linear issue is created",
    "Issue.update": "When a Linear issue changes",
    "Comment.create": "When someone comments in Linear",
  },
  sentry: {
    "issue.created": "When Sentry finds a new issue",
    "issue.resolved": "When a Sentry issue is resolved",
    "error.created": "When Sentry records an error",
  },
  pagerduty: {
    "incident.triggered": "When a PagerDuty incident starts",
    "incident.acknowledged": "When a PagerDuty incident is acknowledged",
    "incident.resolved": "When a PagerDuty incident is resolved",
  },
  email: { received: "When an email arrives" },
  manual: { requested: "When you ask" },
};

/** "a GitHub", "an Email": the article the label takes. */
function withArticle(label: string): string {
  return /^[AEIOU]/i.test(label) ? `an ${label}` : `a ${label}`;
}

/**
 * One event a goal listens for, in words: "When a GitHub check finishes".
 *
 * An event this doesn't know reads "When a GitHub event arrives", never its identifier and never a
 * guess at what it means. `*` is every event from the source. The identifier itself is for the
 * goal's details (`eventDetail`), and the stored and model-facing vocabulary is unchanged.
 */
export function describeEvent(subscription: {
  source: Source;
  eventType: string;
}): string {
  const label = EVENT_SOURCE_LABEL[subscription.source] ?? subscription.source;
  const type = subscription.eventType.trim();
  if (type === "*") return `When any ${label} event arrives`;
  const known = KNOWN[subscription.source]?.[type];
  if (known) return known;
  return `When ${withArticle(label)} event arrives`;
}

/** The same event for a goal's details: the words, and the exact identifier after them. */
export function eventDetail(subscription: {
  source: Source;
  eventType: string;
}): string {
  return `${describeEvent(subscription)} (${EVENT_SOURCE_LABEL[subscription.source] ?? subscription.source} ${subscription.eventType})`;
}
