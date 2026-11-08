/**
 * The cards a Bot asks the person with in the conversation itself, and waits on: the approval card,
 * the choice card and the form.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES. The browser registers each as a human-in-the-loop tool
 * under this name (`app/src/components/gallery`), and the server watches runs for a call to one that
 * is left waiting, which is what puts the Bot under Needs you (`server/src/approvals/decision-waits.ts`).
 * A card renamed on one side only would draw and never be counted.
 *
 * What each one asks for, as the Needs you counts file it: the approval card is an approval, the
 * choice and the form are questions.
 */
export const DECISION_TOOLS = {
  askApproval: "approval",
  askChoice: "question",
  askForm: "question",
} as const;

export type DecisionToolName = keyof typeof DECISION_TOOLS;

export const isDecisionTool = (name: unknown): name is DecisionToolName =>
  typeof name === "string" && Object.hasOwn(DECISION_TOOLS, name);
