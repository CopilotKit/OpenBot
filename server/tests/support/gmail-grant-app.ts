import { effectOf } from "../../src/plugins/composio";
import type { GrantApp } from "../../src/plugins/grant-translate";
import catalogue from "../fixtures/composio-gmail-catalogue.json";

/**
 * Composio's own Gmail listing (`fixtures/composio-gmail-catalogue.json`) as the app's page has it:
 * every action, with the effect and destructive flag OpenBot records from Composio's labels
 * (`effectOf`). The app id and title are the ones `fixtures/app-grants-recorded.json` was recorded
 * against.
 */
export const GMAIL_APP_ID = "composio-gmail";

export const gmailTools = catalogue.gmail.map((tool) => {
  const { effect, destructive } = effectOf(tool.tags);
  return {
    name: tool.slug,
    description: tool.description,
    effect,
    destructive,
  };
});

export function gmailApp(id = GMAIL_APP_ID): GrantApp {
  return {
    id,
    title: "Gmail",
    tools: gmailTools.map((tool) => ({ ...tool, ref: `${id}/${tool.name}` })),
  };
}
