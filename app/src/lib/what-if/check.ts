import type {
  WhatIfAction,
  WhatIfLabels,
  WhatIfRecorded,
  WhatIfResult,
} from "@openbot/shared/what-if";
import {
  askWhatIf as ask,
  checkWhatIf as check,
  explainAuditEvent as explain,
} from "@/lib/api/generated/what-if/what-if";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";

/**
 * A question read as one action, for the admin to confirm, or why it couldn't be. `missing` says what
 * is still to choose before the action can be checked.
 */
export type WhatIfReading =
  | {
      understood: "yes";
      action: WhatIfAction;
      labels: WhatIfLabels;
      missing: string | null;
    }
  | { understood: "no"; unclear: string };

export type WhatIfChecked = {
  action: WhatIfAction;
  labels: WhatIfLabels;
  result: WhatIfResult;
};

/** An audit row's action, what the row recorded, and what the controls say about it now. */
export type WhatIfExplained = WhatIfChecked & { recorded: WhatIfRecorded };

/*
 * Plain functions rather than queries or mutations: each is a verdict about this moment, nothing is
 * cached and nothing is saved. The server records each question and each check on the trail. Asking
 * and checking are writes to the API, so each carries a key of its own.
 */

/** Question in, action out. The model only names the action; nothing is decided yet. */
export async function askWhatIf(question: string): Promise<WhatIfReading> {
  const reading = await ask(
    ORGANIZATION_ID,
    { question },
    { "Idempotency-Key": idempotencyKey() },
    {
      fallback:
        "Couldn't read that question. Try again, or set the action yourself.",
    },
  );
  return reading as WhatIfReading;
}

/** An action in, what every control decides out. No model is asked. */
export async function checkWhatIf(
  action: WhatIfAction,
  question?: string,
): Promise<WhatIfChecked> {
  const checked = await check(
    ORGANIZATION_ID,
    { action, ...(question ? { question } : {}) },
    { "Idempotency-Key": idempotencyKey() },
    { fallback: "Couldn't check that action. Try again." },
  );
  return checked as WhatIfChecked;
}

/** "Why did this happen?" about one audit row, from what the row recorded. No model is asked. */
export async function explainAuditEvent(
  eventId: string,
): Promise<WhatIfExplained> {
  const explained = await explain(ORGANIZATION_ID, eventId, {
    fallback: "Couldn't explain this event. Try again.",
  });
  return explained as WhatIfExplained;
}
