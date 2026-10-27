import {
  IconChevronDown,
  IconHandStop,
  IconMessageQuestion,
  IconShieldCheck,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ApprovalInboxData,
  answerPersonQuestionMutationOptions,
  decideApprovalMutationOptions,
} from "@/lib/approvals";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";
import { actionPhrase } from "./model";
import {
  ErrorNotice,
  IconTile,
  MuseButton,
  MuseCard,
  MuseChip,
  MuseField,
  museText,
} from "./ui";

type ApprovalRequest = ApprovalInboxData["requests"][number];
type PersonQuestion = ApprovalInboxData["questions"][number];

function useBotName() {
  const agents = useQuery(agentListQueryOptions());
  return (id: string) =>
    agents.data?.find((agent) => agent.id === id)?.name ?? id;
}

/**
 * One action a Bot is waiting to take, as an OpenMuse review card. The choices are OpenBot's own —
 * allow once, always allow here, deny; or, for something handed to the person, done or don't — and
 * they go through OpenBot's decision mutation, so the paused run resumes exactly as it would from
 * OpenBot's own screen.
 */
export function ApprovalCard({ request }: { request: ApprovalRequest }) {
  const botName = useBotName();
  const decision = useMutation(decideApprovalMutationOptions(queryClient));
  const [details, setDetails] = useState(false);
  const handOff = request.action.policy?.behaviour === "hand_off";
  const decide = (choice: "allow_once" | "allow_always" | "deny" | "handled") =>
    decision.mutate({ id: request.id, choice });

  return (
    <MuseCard className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <IconTile
          icon={handOff ? IconHandStop : IconShieldCheck}
          tint="lavender"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className={museText.heading}>
            {botName(request.action.botId)}{" "}
            {handOff ? "handed you" : "wants to"}{" "}
            {actionPhrase(request.action.toolRef)}
          </p>
          <p className={`${museText.small} break-all`}>
            {request.action.scope}
            {` · ${relativeTime(request.createdAt)}`}
          </p>
        </div>
        <MuseChip tint="lavender">
          {handOff ? "Yours to do" : "Review"}
        </MuseChip>
      </div>
      {request.action.policy?.reason ? (
        <p className={museText.muted}>{request.action.policy.reason}</p>
      ) : null}
      <button
        aria-expanded={details}
        className={`${museText.small} flex items-center gap-1 self-start font-semibold text-foreground`}
        onClick={() => setDetails(!details)}
        type="button"
      >
        {details ? "Hide details" : "What it will send"}
        <IconChevronDown
          aria-hidden="true"
          className={`size-3 transition-transform ${details ? "rotate-180" : ""}`}
        />
      </button>
      {details ? (
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-[14px] border-[var(--openmuse-blue)] border-l-2 bg-background p-3 text-[11px] text-muted-foreground leading-[17px]">
          {JSON.stringify(request.action.args, null, 2)}
        </pre>
      ) : null}
      <ErrorNotice error={decision.error?.message} />
      <div className="flex flex-wrap gap-2">
        {handOff ? (
          <>
            <MuseButton
              disabled={decision.isPending}
              onClick={() => decide("handled")}
              primary
            >
              I did it myself
            </MuseButton>
            <MuseButton
              disabled={decision.isPending}
              onClick={() => decide("deny")}
            >
              Don't do it
            </MuseButton>
          </>
        ) : (
          <>
            <MuseButton
              disabled={decision.isPending}
              onClick={() => decide("allow_once")}
              primary
            >
              Allow once
            </MuseButton>
            <MuseButton
              disabled={decision.isPending}
              onClick={() => decide("allow_always")}
            >
              Always allow here
            </MuseButton>
            <MuseButton
              danger
              disabled={decision.isPending}
              onClick={() => decide("deny")}
            >
              Deny
            </MuseButton>
          </>
        )}
      </div>
    </MuseCard>
  );
}

/** A question a Bot asked mid-run. Answering resumes the run with the answer. */
export function QuestionCard({ question }: { question: PersonQuestion }) {
  const botName = useBotName();
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  const [text, setText] = useState("");
  return (
    <MuseCard className="flex flex-col gap-3 bg-[var(--openmuse-sky)]">
      <div className="flex items-start gap-3">
        <IconTile accent icon={IconMessageQuestion} tint="plain" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className={museText.heading}>{question.question}</p>
          <p className={museText.small}>
            {botName(question.botId)} asks · {relativeTime(question.createdAt)}
          </p>
        </div>
        <MuseChip>New</MuseChip>
      </div>
      {question.why ? <p className={museText.muted}>{question.why}</p> : null}
      <MuseField
        label="Your answer"
        multiline
        onChange={(event) => setText(event.target.value)}
        placeholder="Tell it what to do"
        value={text}
      />
      <ErrorNotice error={answer.error?.message} />
      <MuseButton
        className="-mt-2 self-start"
        disabled={answer.isPending || !text.trim()}
        onClick={() => answer.mutate({ id: question.id, response: text })}
        primary
      >
        Send answer
      </MuseButton>
    </MuseCard>
  );
}
