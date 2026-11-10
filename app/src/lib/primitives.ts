import {
  type Icon,
  IconBook,
  IconBrain,
  IconChecks,
  IconClock,
  IconDeviceDesktop,
  IconHistory,
  IconLock,
  IconMessages,
  IconPlug,
  IconSettings,
} from "@tabler/icons-react";

/**
 * The eight things a Bot has, in the one order every list of them keeps: on a Bot's page, in
 * Settings, in Admin, in the docs and in the tour. See `docs/how-openbot-works.md`.
 *
 * The order is not a quota. A list leaves out a primitive that has nothing to set where it is
 * drawn (Conversations is never a settings row; Memory only where OpenBot offers it), and never
 * reorders the rest or adds a row to complete the set. Sort with `byPrimitive` rather than by hand.
 */
export type PrimitiveId =
  | "conversations"
  | "routines"
  | "memory"
  | "skills"
  | "apps"
  | "computer"
  | "approvals"
  | "activity";

export type Primitive = {
  id: PrimitiveId;
  /** Its one name, as a page, a menu entry or a row says it. */
  label: string;
  /** The pair it belongs to. */
  pair: "Works" | "Learns" | "Uses" | "Answers to you";
  /** The one question it answers, in the person's words. */
  question: string;
  icon: Icon;
};

export const PRIMITIVES: readonly Primitive[] = [
  {
    id: "conversations",
    label: "Conversations",
    pair: "Works",
    question: "How do I give it work?",
    icon: IconMessages,
  },
  {
    id: "routines",
    label: "Routines",
    pair: "Works",
    question: "When does it work without being asked?",
    icon: IconClock,
  },
  {
    id: "memory",
    label: "Memory",
    pair: "Learns",
    question: "What does it know about me and my work?",
    icon: IconBrain,
  },
  {
    id: "skills",
    label: "Skills",
    pair: "Learns",
    question: "What does it know how to do?",
    icon: IconBook,
  },
  {
    id: "apps",
    label: "Apps",
    pair: "Uses",
    question: "Which of my services can it reach?",
    icon: IconPlug,
  },
  {
    id: "computer",
    label: "Computer",
    pair: "Uses",
    question: "Where does it browse, run commands and keep files?",
    icon: IconDeviceDesktop,
  },
  {
    id: "approvals",
    label: "Approvals",
    pair: "Answers to you",
    question: "When does it stop and ask me?",
    icon: IconChecks,
  },
  {
    id: "activity",
    label: "Activity",
    pair: "Answers to you",
    question: "What did it do?",
    icon: IconHistory,
  },
];

const BY_ID = new Map(PRIMITIVES.map((primitive) => [primitive.id, primitive]));

/** One primitive by id. */
export function primitive(id: PrimitiveId): Primitive {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown primitive: ${id}`);
  return found;
}

/** Where a primitive sits in the order, from 0 for Conversations. */
export function primitiveIndex(id: PrimitiveId): number {
  return PRIMITIVES.findIndex((primitive) => primitive.id === id);
}

/**
 * A comparator that puts things tagged with a primitive into the fixed order. Anything without one
 * (Setup, Sharing, Team) sorts after the eight and keeps the order it came in.
 */
export function byPrimitive<T extends { primitive?: PrimitiveId }>(
  a: T,
  b: T,
): number {
  const at = a.primitive ? primitiveIndex(a.primitive) : PRIMITIVES.length;
  const bt = b.primitive ? primitiveIndex(b.primitive) : PRIMITIVES.length;
  return at - bt;
}

/** Beside the eight: a Bot's name and instructions. */
export const SETUP = { label: "Setup", icon: IconSettings } as const;

/** Beside the eight: the person's saved logins and keys, which no Bot sees. */
export const VAULT = { label: "Vault", icon: IconLock } as const;

/**
 * Names that are no longer a page, a menu entry or a row that leads to one. Each is still fine as
 * a word in a sentence ("a goal", "a check-in") and as a label inside a page. Matched against a
 * whole title, so "Automatic learning" is not "Learning".
 * `tests/no-retired-page-names.test.ts` reads this list.
 */
export const RETIRED_PAGE_NAMES: readonly { name: string; now: string }[] = [
  { name: "Goals", now: "Routines" },
  { name: "Check-ins", now: "Routines" },
  { name: "Responsibilities", now: "Routines" },
  { name: "Capabilities", now: "Skills, or Memory" },
  { name: "Learning", now: "Skills" },
  { name: "What it can do", now: "Skills, Apps, Approvals" },
  { name: "Skills and access", now: "Skills, or Apps" },
  { name: "Saved logins", now: "Vault" },
  { name: "Passwords", now: "Vault" },
  { name: "Keys", now: "Vault" },
  { name: "Credentials", now: "Vault" },
  { name: "Browsers", now: "Computer" },
  { name: "This computer", now: "Computer" },
  { name: "Approval rules", now: "Approvals" },
  { name: "Audit", now: "Activity" },
  { name: "Plugins", now: "Apps" },
];
