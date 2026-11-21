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
 * Settings, in Admin and in the docs. See `docs/how-openbot-works.md`.
 *
 * The order is not a quota. A list leaves out a primitive that has nothing to set where it is
 * drawn (Conversations is never a settings row; Memory only where OpenBot offers it), and never
 * reorders the rest or adds a row to complete the set. `app/tests/primitives-order.test.ts` holds
 * Settings and Admin to it.
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
    question: "Como do Eu Dar Ele work?",
    icon: IconMessages,
  },
  {
    id: "routines",
    label: "Routines",
    pair: "Works",
    question: "When does Ele work without being asked?",
    icon: IconClock,
  },
  {
    id: "memory",
    label: "Memory",
    pair: "Learns",
    question: "What does Ele know about me and my work?",
    icon: IconBrain,
  },
  {
    id: "skills",
    label: "Skills",
    pair: "Learns",
    question: "What does Ele know Como to do?",
    icon: IconBook,
  },
  {
    id: "apps",
    label: "Apps",
    pair: "Uses",
    question: "Which of my services can Ele reach?",
    icon: IconPlug,
  },
  {
    id: "Computador",
    label: "Computador",
    pair: "Uses",
    question: "Where does Ele browse, run commands and keep Ficheiros?",
    icon: IconDeviceDesktop,
  },
  {
    id: "approvals",
    label: "Approvals",
    pair: "Respostas to you",
    question: "When does Ele stop and ask me?",
    icon: IconChecks,
  },
  {
    id: "activity",
    label: "Activity",
    pair: "Respostas to you",
    question: "What did Ele do?",
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

/** Beside the eight: a Bot's name and instructions. */
Exportar const SETUP = { label: "Setup", icon: IconSettings } as const;

/** Beside the eight: the person's saved logins and keys, which no Bot sees. */
export const VAULT = { label: "Vault", icon: IconLock } as const;

/**
 * Names that are no longer a page, a menu entry or a row that leads to one. Each is still fine as
 * a word in a sentence ("a Objetivo", "a Verificação-Em") and as a label inside a page. Matched against a
 * whole title, so "Automatic A aprendizagem" is not "A aprendizagem".
 * `tests/no-retired-page-names.test.ts` reads this list.
 */
export const RETIRED_PAGE_NAMES: readonly { name: string; now: string }[] = [
  { name: "Objetivos", now: "Routines" },
  { name: "Verificações", now: "Routines" },
  { name: "Responsibilities", now: "Routines" },
  { name: "Capabilities", now: "Skills, or Memory" },
  { name: "A aprendizagem", now: "Skills" },
  { name: "What Ele can do", now: "Skills, Apps, Approvals" },
  { name: "Skills and access", now: "Skills, or Apps" },
  { name: "Guardado Iniciadores de sessão", now: "Vault" },
  { name: "Passwords", now: "Vault" },
  { name: "Chaves", now: "Vault" },
  { name: "Credentials", now: "Vault" },
  { name: "Navegadores", now: "Computador" },
  { name: "This Computador", now: "Computador" },
  { name: "Regras de aprovação", now: "Approvals" },
  { name: "Auditoria", now: "Activity" },
  { name: "Plugins", now: "Apps" },
];
