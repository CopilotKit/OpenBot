// The "Ask for" choice of the Comment box, and "Critique this screen": a change request
// (commentPrompt.ts) or an impeccable command (critiquePrompt.ts) about the picked part of the
// window, or about the whole window. Pure: no browser.

import {
  buildPrompt,
  type CommentContext,
  type CommentTarget,
  type PickedElement,
} from "./commentPrompt";
import {
  buildCritiquePrompt,
  CRITIQUE_COMMANDS,
  type CritiqueCommand,
  type CritiqueContext,
  type FrameElement,
  type FrameReport,
} from "./critiquePrompt";
import type { Box } from "./geometry";
import type { Warning } from "./layoutWatch";

/** What the prompt asks the agent for: a change, or an impeccable command. */
export type AskFor = "change" | CritiqueCommand;

export const ASK_CHOICES: readonly AskFor[] = ["change", ...CRITIQUE_COMMANDS];

export const ASK_LABELS: Record<AskFor, string> = {
  change: "Change request",
  critique: "Critique",
  audit: "Audit",
  layout: "Layout",
  typeset: "Typeset",
  clarify: "Clarify",
  polish: "Polish",
};

/** The parts of the loaded window that an impeccable prompt needs and a comment does not have. */
export type AskFrame = {
  kind: "desktop" | "app";
  warnings: readonly Warning[];
};

export function isAskFor(value: string): value is AskFor {
  return (ASK_CHOICES as readonly string[]).includes(value);
}

function warningBox(warning: Warning): Box {
  return warning.kind === "moved" ? warning.to : warning.box;
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** The layout warnings whose box touches `box`. */
export function warningsIn(warnings: readonly Warning[], box: Box): Warning[] {
  return warnings.filter((w) => overlaps(warningBox(w), box));
}

function frameElement(el: PickedElement): FrameElement {
  return { label: el.label, box: el.box, text: el.text, chain: el.chain };
}

function critiqueContext(
  command: CritiqueCommand,
  context: CommentContext,
): CritiqueContext {
  return {
    command,
    scene: context.scene,
    window: context.window,
    host: context.app?.host ?? "desktop",
    // The host the frame shows now: a shot with it renders the same frame.
    hostFlag: context.app?.host ?? null,
    route: context.app?.route,
    link: context.link,
    files: false,
  };
}

/**
 * The prompt for the Comment box. "change" is the change request of commentPrompt.ts and needs
 * the person's words. An impeccable command reviews only the picked element or area: its target is
 * the main source file of the picked elements, and the person's words go with it when there are some.
 */
export function buildAskPrompt(
  ask: AskFor,
  target: CommentTarget,
  context: CommentContext,
  frame: AskFrame,
): string {
  if (ask === "change") return buildPrompt(target, context);
  const elements =
    target.kind === "element" ? [target.element] : target.elements;
  const box = target.kind === "element" ? target.element.box : target.area;
  const what =
    target.kind === "element"
      ? `the element "${target.element.label}"`
      : `an area with ${elements.length} ${elements.length === 1 ? "element" : "elements"}`;
  const report: FrameReport = {
    kind: frame.kind,
    elements: elements.map(frameElement),
    warnings: warningsIn(frame.warnings, box),
  };
  return buildCritiquePrompt(report, {
    ...critiqueContext(ask, context),
    scope: { what, box },
    note: context.comment,
  });
}

/** "Critique this screen": an impeccable command on the whole window, with every warning. */
export function buildScreenPrompt(
  command: CritiqueCommand,
  elements: readonly PickedElement[],
  context: Omit<CommentContext, "comment">,
  frame: AskFrame,
): string {
  const report: FrameReport = {
    kind: frame.kind,
    elements: elements.map(frameElement),
    warnings: frame.warnings,
  };
  return buildCritiquePrompt(
    report,
    critiqueContext(command, { ...context, comment: "" }),
  );
}
