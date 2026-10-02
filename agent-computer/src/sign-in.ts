/**
 * Typing a person's login into the Bot's page, on this side of the wire.
 *
 * The private sign-in form posts a username and password to the server, the server posts them here,
 * and this types them. The Bot is never involved: it does not pick the fields, it does not see the
 * values, and what comes back says only whether a form was submitted and whether a password field is
 * still showing.
 *
 * Three refusals, before anything is typed:
 *  - the page must be on the exact origin the person was asked to sign in to, so a login cannot be
 *    carried to a page that redirected somewhere else (or that the Bot navigated to afterwards);
 *  - there must be a login form on it;
 *  - a two-step login that moves to another origin between the username and password (an identity
 *    provider, say) is not followed: the person is asked to take over instead.
 *
 * Every failure is one of this module's own sentences. A Playwright error can quote the call it was
 * making, and this call's arguments are a password.
 */
import type { Locator, Page } from "playwright";
import { markElementSecret, SECRET_ATTRIBUTE } from "./secret-masking";

export type SignInFillInput = {
  origin: string;
  username?: string;
  password: string;
  code?: string;
};

export type SignInFillResult = {
  submitted: boolean;
  passwordFieldVisible: boolean;
  url: string;
  error?: string;
};

const LOGIN_ATTRIBUTE = "data-openbot-login";
const STEP_TIMEOUT_MS = 15_000;

/** The origin of a URL, or empty for one that has none (`about:blank`). */
export function originOfUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : "";
  } catch {
    return "";
  }
}

/** Parse the body the server sends, without ever putting a value in an error. */
export function parseSignInFill(body: unknown): SignInFillInput | string {
  if (!body || typeof body !== "object") return "A sign-in needs a JSON body.";
  const input = body as Record<string, unknown>;
  if (typeof input.origin !== "string" || !originOfUrl(input.origin))
    return "A sign-in names the website's origin.";
  if (typeof input.password !== "string" || !input.password)
    return "A sign-in needs a password.";
  if (input.username !== undefined && typeof input.username !== "string")
    return "The username must be text.";
  if (input.code !== undefined && typeof input.code !== "string")
    return "The code must be text.";
  return {
    origin: originOfUrl(input.origin),
    password: input.password,
    ...(input.username ? { username: input.username } : {}),
    ...(input.code ? { code: input.code } : {}),
  };
}

/**
 * Find the login fields on the page and mark them for the locators below.
 *
 * Runs in the page. A password field is any visible `input[type=password]`; the username is the
 * visible text-like input before it in the same form, preferring one the site labels as a username or
 * email. With no password field, a lone username field is the first step of a two-step login.
 */
function markLoginFields(attribute: string) {
  for (const node of document.querySelectorAll(`[${attribute}]`))
    node.removeAttribute(attribute);
  const visible = (element: Element) => {
    const input = element as HTMLInputElement;
    const box = input.getBoundingClientRect();
    const style = getComputedStyle(input);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      !input.disabled &&
      !input.readOnly
    );
  };
  const passwords = [
    ...document.querySelectorAll<HTMLInputElement>("input[type=password]"),
  ].filter(visible);
  const password =
    passwords.find((input) => /current-password/.test(input.autocomplete)) ??
    passwords[0];
  const scope: ParentNode = password?.form ?? document;
  const textLike = [
    ...scope.querySelectorAll<HTMLInputElement>("input"),
  ].filter(
    (input) =>
      ["text", "email", "tel", ""].includes(input.type) &&
      visible(input) &&
      (!password ||
        Boolean(
          input.compareDocumentPosition(password) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        )),
  );
  const named = (input: HTMLInputElement) =>
    /username|email/.test(input.autocomplete) ||
    input.type === "email" ||
    /user|email|login|account|identifier/i.test(
      `${input.name} ${input.id} ${input.getAttribute("aria-label") ?? ""}`,
    );
  const username =
    textLike.filter(named).at(-1) ?? (password ? textLike.at(-1) : undefined);
  if (username) username.setAttribute(attribute, "username");
  if (password) password.setAttribute(attribute, "password");
  return { username: Boolean(username), password: Boolean(password) };
}

/** Find a one-time-code field. Runs in the page. */
function markCodeField(attribute: string) {
  const inputs = [
    ...document.querySelectorAll<HTMLInputElement>("input"),
  ].filter((input) => {
    const box = input.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      !input.disabled &&
      input.type !== "hidden"
    );
  });
  const code =
    inputs.find((input) => /one-time-code/.test(input.autocomplete)) ??
    inputs.find((input) =>
      /code|otp|totp|2fa|mfa|verif|token/i.test(`${input.name} ${input.id}`),
    );
  if (code) code.setAttribute(attribute, "code");
  return Boolean(code);
}

/**
 * How a form is sent, decided in the page: its own submit button when it has one, the form itself
 * when it has none (a form with several fields and no button ignores Enter), and Enter otherwise.
 */
function markSubmit(
  field: Element,
  attribute: string,
): "button" | "form" | "key" {
  const form = (field as HTMLInputElement).form;
  if (!form) return "key";
  const button = form.querySelector(
    "button:not([type=button]):not([type=reset]), input[type=submit]",
  );
  if (button) {
    button.setAttribute(attribute, "submit");
    return "button";
  }
  return "form";
}

async function submitFrom(page: Page, field: Locator) {
  const how = await field.evaluate(markSubmit, LOGIN_ATTRIBUTE);
  if (how === "button")
    await page
      .locator(`[${LOGIN_ATTRIBUTE}="submit"]`)
      .click({ timeout: STEP_TIMEOUT_MS });
  else if (how === "form")
    await field.evaluate((element) =>
      (element as HTMLInputElement).form?.requestSubmit(),
    );
  else await field.press("Enter", { timeout: STEP_TIMEOUT_MS });
}

async function settle(page: Page) {
  await page.waitForTimeout(800);
  await page
    .waitForLoadState("load", { timeout: STEP_TIMEOUT_MS })
    .catch(() => undefined);
  await page
    .waitForLoadState("networkidle", { timeout: 5_000 })
    .catch(() => undefined);
}

async function passwordVisible(page: Page) {
  return (await page.locator("input[type=password]:visible").count()) > 0;
}

async function typeSecret(field: Locator, value: string) {
  await field.fill(value, { timeout: STEP_TIMEOUT_MS });
  await field.evaluate(markElementSecret, SECRET_ATTRIBUTE);
}

export async function fillSignIn(
  page: Page,
  input: SignInFillInput,
): Promise<SignInFillResult> {
  const answer = (error: string, submitted = false): SignInFillResult => ({
    submitted,
    passwordFieldVisible: false,
    url: page.url(),
    error,
  });
  if (originOfUrl(page.url()) !== input.origin)
    return answer(
      `The Bot's browser is not on ${input.origin}. Ask it to open that site's sign-in page and try again.`,
    );
  try {
    let found = await page.evaluate(markLoginFields, LOGIN_ATTRIBUTE);
    if (!found.password && !found.username)
      return answer("There is no sign-in form on the page the Bot has open.");
    const usernameField = page.locator(`[${LOGIN_ATTRIBUTE}="username"]`);
    if (found.username && input.username)
      await usernameField.fill(input.username, { timeout: STEP_TIMEOUT_MS });
    if (!found.password) {
      // Two steps: username first, then the site shows the password field.
      if (!input.username)
        return answer(
          "This site asks for a username first. Enter one and try again.",
        );
      await submitFrom(page, usernameField);
      await page
        .locator("input[type=password]:visible")
        .first()
        .waitFor({ timeout: STEP_TIMEOUT_MS })
        .catch(() => undefined);
      if (originOfUrl(page.url()) !== input.origin)
        return answer(
          `The sign-in moved to ${originOfUrl(page.url()) || "another page"}. Take over the browser to finish signing in there.`,
          true,
        );
      found = await page.evaluate(markLoginFields, LOGIN_ATTRIBUTE);
      if (!found.password)
        return answer(
          "The site did not ask for a password after the username.",
          true,
        );
    }
    const passwordField = page.locator(`[${LOGIN_ATTRIBUTE}="password"]`);
    await typeSecret(passwordField, input.password);
    await submitFrom(page, passwordField);
    await settle(page);
    if (input.code) {
      if (originOfUrl(page.url()) !== input.origin)
        return answer(
          `The sign-in moved to ${originOfUrl(page.url()) || "another page"} before the code was asked for. Take over the browser to finish.`,
          true,
        );
      let hasCode = await page.evaluate(markCodeField, LOGIN_ATTRIBUTE);
      if (!hasCode) {
        await page.waitForTimeout(2_000);
        hasCode = await page.evaluate(markCodeField, LOGIN_ATTRIBUTE);
      }
      if (hasCode) {
        const codeField = page.locator(`[${LOGIN_ATTRIBUTE}="code"]`);
        await typeSecret(codeField, input.code);
        await submitFrom(page, codeField);
        await settle(page);
      }
    }
    return {
      submitted: true,
      passwordFieldVisible: await passwordVisible(page),
      url: page.url(),
    };
  } catch {
    return answer("The login could not be typed into the page.");
  }
}
