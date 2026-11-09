import type { BrokerField } from "./broker";

/**
 * Where a person gets the key an app asks for, and the boxes of its form in words they can follow.
 *
 * WHY THIS EXISTS. Most of the broker's catalogue has no sign-in it can send somebody to: of 1,723
 * apps read on 2026-11-08, 126 had a sign-in the broker runs itself and 1,344 only took a key or a
 * token typed in. The form for those draws the provider's own field names and descriptions, which
 * are written for a developer ("Bearer Token", "Service Account Token (ops_* prefix), Connect
 * Server Access Token, or Events API Bearer Token"), and says nothing about where to go. A person
 * who expected a sign-in met a form and no way forward.
 *
 * THE LINK COMES FROM THE BROKER FIRST. Composio publishes an `auth_hint_url` on a connection mode
 * and an `auth_guide_url` on the app. Both are empty for nearly every app (the guide on all 1,723;
 * the hint on all but a few, Braze, Beehiiv and HiBob among them), so the map below is what most
 * key apps get. Every link in it was opened on 2026-11-08 and lands on the provider's own page for
 * making the key, or on its documentation for it.
 *
 * THE MAP IS THE MOST-USED KEY-ONLY APPS, NOT ALL OF THEM. An app missing from it still gets the
 * plain explanation and the provider's own field help; it gets no link, because a guessed link is
 * worse than none. Add an app by its catalogue slug.
 */
export type KeyGuide = {
  /** What to do at the provider, in one or two sentences a person can follow. */
  steps: string;
  /** The provider's own page for making the key, or its documentation for it. */
  url: string;
  /**
   * Boxes whose published label or help does not serve a person, rewritten, keyed by the field's
   * published `name`. The provider's specifics (a prefix, a menu path) are kept in the rewrite.
   */
  fields?: Record<string, { label?: string; help?: string }>;
};

export const KEY_GUIDES: Record<string, KeyGuide> = {
  _1password: {
    steps:
      "1Password connects through a Connect server that your 1Password admin runs. They create it in 1Password.com under Developer, along with an access token for it.",
    url: "https://www.1password.dev/connect/get-started",
    fields: {
      full: {
        label: "Connect server address",
        help: "The web address of your Connect server, for example https://connect.example.com. Your 1Password admin can tell you what it is.",
      },
      generic_api_key: {
        label: "Access token",
        help: "The access token made for that Connect server. Your 1Password admin can find it in 1Password.com under Developer, then Connect servers.",
      },
    },
  },
  openai: {
    steps: "Create a secret key on the API keys page of your OpenAI account.",
    url: "https://platform.openai.com/api-keys",
  },
  posthog: {
    steps:
      "In PostHog, open Settings, then Personal API keys, and create a key. Copy it straight away, because PostHog shows it only once.",
    url: "https://posthog.com/docs/api",
  },
  sendgrid: {
    steps:
      "In SendGrid, open Settings, then API Keys, and create a key with full access. Copy it straight away, because SendGrid shows it only once.",
    url: "https://www.twilio.com/docs/sendgrid/ui/account-and-settings/api-keys",
  },
  elevenlabs: {
    steps:
      "Create an API key in your ElevenLabs account and copy it straight away, because it's shown only once.",
    url: "https://elevenlabs.io/app/developers/api-keys",
  },
  firecrawl: {
    steps: "Sign in to Firecrawl and copy your key from the API Keys page.",
    url: "https://www.firecrawl.dev/app/api-keys",
  },
  tavily: {
    steps: "Sign in to Tavily and copy a key from the API Keys section.",
    url: "https://app.tavily.com/home",
  },
  serpapi: {
    steps: "Sign in to SerpApi and copy your private API key.",
    url: "https://serpapi.com/manage-api-key",
  },
  perplexityai: {
    steps:
      "Create an API key in your Perplexity account and copy it straight away, because it's shown only once.",
    url: "https://www.perplexity.ai/account/api/keys",
  },
  exa: {
    steps: "Sign in to Exa and create or copy a key on the API keys page.",
    url: "https://dashboard.exa.ai/api-keys",
  },
  cloudflare: {
    steps:
      "Copy the Global API Key from your Cloudflare profile, and enter the email address you sign in to Cloudflare with.",
    url: "https://developers.cloudflare.com/fundamentals/api/get-started/keys/",
  },
  pandadoc: {
    steps: "Create an API key in your PandaDoc account. The link shows how.",
    url: "https://developers.pandadoc.com/reference/api-key-authentication-process",
  },
  mixpanel: {
    steps:
      "In Mixpanel, open Organization Settings, then Service Accounts, and create one. Copy its secret straight away, because it's shown only once.",
    url: "https://developer.mixpanel.com/reference/service-accounts",
  },
  algolia: {
    steps:
      "Copy your Application ID and an API key from the Algolia dashboard. A search-only key is enough for reading.",
    url: "https://www.algolia.com/doc/guides/security/api-keys/",
  },
  apify: {
    steps:
      "In Apify Console, open Settings, then API & Integrations, and copy your API token.",
    url: "https://console.apify.com/settings/integrations",
  },
  apollo: {
    steps:
      "In Apollo, open Settings, then Integrations, then API Keys, and create a key. Turn on Set as master key so every action works.",
    url: "https://docs.apollo.io/docs/create-api-key",
  },
  replicate: {
    steps: "Sign in to Replicate and copy a token from the API tokens page.",
    url: "https://replicate.com/account/api-tokens",
  },
  deepgram: {
    steps: "Create an API key in the Deepgram console.",
    url: "https://developers.deepgram.com/docs/create-additional-api-keys",
  },
  datadog: {
    steps:
      "In Datadog, open Organization Settings. Copy an API key from API Keys and an application key from Application Keys.",
    url: "https://docs.datadoghq.com/account_management/api-app-keys/",
  },
  telegram: {
    steps:
      "In Telegram, message @BotFather and send /newbot to make a bot and get its token. This connects a bot, not your own Telegram account.",
    url: "https://core.telegram.org/bots/tutorial#obtain-your-bot-token",
  },
  shortcut: {
    steps: "Create an API token in your Shortcut settings.",
    url: "https://developer.shortcut.com/api/rest/v3",
  },
  toggl: {
    steps: "Copy the API token from your Toggl Track profile settings.",
    url: "https://track.toggl.com/profile",
  },
  cloudinary: {
    steps:
      "Copy your cloud name, API key and API secret from the Cloudinary console.",
    url: "https://console.cloudinary.com/settings/api-keys",
  },
  postmark: {
    steps:
      "In Postmark, open your server, then the API Tokens tab, and copy the Server API token.",
    url: "https://postmarkapp.com/support/article/1008-what-are-the-account-and-server-api-tokens",
  },
  amplitude: {
    steps: "Copy your project's API key and secret key from Amplitude.",
    url: "https://amplitude.com/docs/apis/authentication",
  },
  segment: {
    steps: "Create a Public API token in your Segment workspace.",
    url: "https://twilio.com/docs/segment/api/public-api",
  },
  close: {
    steps:
      "In Close, open Settings, then Developer, then API Keys, and create a key. Copy it straight away, because it's shown in full only once.",
    url: "https://help.close.com/integrations/api-keys-oauth",
  },
  ashby: {
    steps:
      "An Ashby admin creates the key under Admin, then Integrations, then API Keys. Copy it straight away, because it's shown only once.",
    url: "https://developers.ashbyhq.com/docs/authentication",
  },
  assemblyai: {
    steps:
      "In the AssemblyAI dashboard, open Workspace, then Manage, then API Keys, and copy a key for the project you want to use.",
    url: "https://www.assemblyai.com/app/api-keys",
  },
  freshdesk: {
    steps:
      "In Freshdesk, open your profile picture, then Profile Settings, and select View API key.",
    url: "https://support.freshdesk.com/support/solutions/articles/215517-how-to-find-your-api-key",
  },
  heygen: {
    steps: "In HeyGen, open Settings, then API, and copy your key.",
    url: "https://app.heygen.com/settings?nav=API",
  },
  mem0: {
    steps: "Copy an API key from your Mem0 settings.",
    url: "https://app.mem0.ai/dashboard/api-keys",
  },
  browserbase_tool: {
    steps: "Sign in to Browserbase and copy your API key from Settings.",
    url: "https://www.browserbase.com/settings",
  },
};

/**
 * Labels the catalogue publishes again and again, in the words the rest of OpenBot uses.
 *
 * Only the generic ones. A label naming the app ("Postmark Server API Token") already says what
 * it is and is left alone.
 */
const PLAIN_LABELS: Record<string, string> = {
  "API Key": "API key",
  "Api Key": "API key",
  "API Token": "API token",
  "API Secret": "API secret",
  "Bearer Token": "Access token",
  "Base URL": "Web address",
  "API URL": "API web address",
  "Sub Domain": "Subdomain",
  Username: "Username",
  Password: "Password",
};

/**
 * The broker's own name, which a person never reads: they see OpenBot. A provider's help sentence
 * sometimes names it ("lets Composio access your campaigns"), and that is the sentence's one word
 * about who is asking, so it becomes OpenBot.
 */
const BROKER_NAME = /\bcomposio\b/gi;

function forPerson(text: string): string {
  return text.replace(BROKER_NAME, "OpenBot");
}

/** The form's boxes, each labelled and explained for a person. Names and order are untouched. */
export function fieldsForPerson(
  toolkit: string,
  fields: BrokerField[],
): BrokerField[] {
  const rewrites = Object.hasOwn(KEY_GUIDES, toolkit)
    ? (KEY_GUIDES[toolkit]?.fields ?? {})
    : {};
  return fields.map((field) => {
    const rewrite = Object.hasOwn(rewrites, field.name)
      ? rewrites[field.name]
      : undefined;
    const label =
      rewrite?.label ??
      (Object.hasOwn(PLAIN_LABELS, field.label)
        ? PLAIN_LABELS[field.label]
        : undefined) ??
      field.label;
    return {
      ...field,
      label: forPerson(label),
      help: forPerson(rewrite?.help ?? field.help),
    };
  });
}

/** What the connect dialog says above the form: what to do, and the page to do it on. */
export type ConnectionGuide = {
  steps: string;
  url: string | null;
};

/**
 * A link the broker published is used only when it is a provider's page: https, and not the
 * broker's own site, which would put the broker's name in front of a person and is not where a key
 * is made.
 */
function providerLink(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (/(^|\.)composio\.dev$/i.test(parsed.hostname)) return null;
  return parsed.toString();
}

/**
 * The guide for one app: the broker's own link where it published one, else the map's, and the
 * map's steps where the app is in it.
 */
export function connectionGuide(input: {
  toolkit: string;
  title: string;
  /** The link the broker published for this app's key, if any. */
  published: string | null;
}): ConnectionGuide {
  const mapped = Object.hasOwn(KEY_GUIDES, input.toolkit)
    ? KEY_GUIDES[input.toolkit]
    : undefined;
  return {
    steps:
      mapped?.steps ??
      `Sign in to ${input.title} and look for API keys in its settings or developer pages.`,
    url: providerLink(input.published) ?? mapped?.url ?? null,
  };
}
