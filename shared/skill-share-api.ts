import { z } from "zod";

export type SkillShareKind = "share" | "make_bot";
export type SkillShareStatus =
  | "pending"
  | "approved"
  | "declined"
  | "superseded";
export type SkillShareRequest = {
  id: string;
  kind: SkillShareKind;
  skillSlug: string;
  skillTitle: string;
  requestedBy: { id: string; name: string; email: string };
  bot: { name: string; title: string; roleDescription: string } | null;
  status: SkillShareStatus;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  createdBotId: string | null;
  createdAt: string;
};

const slug = z.string().min(1).max(200);

export const skillShareRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("share"), skillSlug: slug }).strict(),
  z
    .object({
      kind: z.literal("make_bot"),
      skillSlug: slug,
      // The same bounds POST /api/agents applies (server/src/agents/routes.ts parseAgentInput).
      bot: z
        .object({
          name: z.string().trim().min(1).max(80),
          title: z.string().trim().min(1).max(120),
          roleDescription: z.string().trim().min(1).max(1000),
        })
        .strict(),
    })
    .strict(),
]);
export type SkillShareRequestInput = z.infer<typeof skillShareRequestSchema>;

export const approveSkillShareSchema = z
  .object({
    addToBotIds: z.array(z.string().min(1).max(200)).max(50).default([]),
  })
  .strict();

export type MySkillSharesResponse = {
  requests: SkillShareRequest[];
  recordedSlugs: string[];
};

export const skillSharePaths = {
  requests: "/api/approvals/skill-shares",
  mine: "/api/approvals/skill-shares/mine",
  approve: (requestId: string) =>
    `/api/approvals/skill-shares/${encodeURIComponent(requestId)}/approve`,
  decline: (requestId: string) =>
    `/api/approvals/skill-shares/${encodeURIComponent(requestId)}/decline`,
} as const;
