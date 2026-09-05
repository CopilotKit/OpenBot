import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProposedSkillCard } from "@/components/skills/proposed-skill";
import { skillCardAnswer } from "@/lib/skills/proposal";

/**
 * The card a Bot's draft skill stops on, and the answers it can give.
 *
 * The card IS the tool: `save_skill` has no handler, so the run suspends here and every way out is a
 * render away from a `respond` call. That makes the states worth pinning individually — a card that
 * answers twice resumes a turn that has already moved on, and one that answers a server refusal ends
 * the turn at the moment the person could have fixed it and pressed again.
 *
 * Nothing is stubbed. Saving is a prop, so the card is exercised with a plain function and the
 * transport never enters this file.
 *
 * Queries come off `render()`'s return rather than `screen`, and the window is installed and removed
 * around this file rather than at module scope, so the suite can be walked in any order without this
 * file deciding whether a later one has a DOM.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/** A draft that passes the fields, so each test varies only the thing it is about. */
const DRAFT = {
  slug: "weekly-summary",
  title: "Weekly summary",
  summary: "Say what moved this week.",
  instructions: "List what moved this week, newest first. Name each source.",
  tools: ["google-drive/search_files"],
};

test("a draft still streaming shows no controls to press", () => {
  // `respond` is absent until the arguments are complete. A button drawn before then would answer
  // the tool call with a skill the model had not finished writing.
  const { getByText, queryByRole } = render(
    <ProposedSkillCard args={{ slug: "weekly" }} save={async () => {}} />,
  );

  expect(getByText("Writing the skill…")).toBeTruthy();
  expect(queryByRole("button")).toBeNull();
});

test("a complete draft shows the whole instruction before anything is written", () => {
  const { getByText, getByRole } = render(
    <ProposedSkillCard
      args={DRAFT}
      respond={async () => {}}
      save={async () => {}}
    />,
  );

  // The instruction in full, because it is the part somebody is actually agreeing to.
  expect(
    getByText("List what moved this week, newest first. Name each source."),
  ).toBeTruthy();
  expect(getByText("/weekly-summary")).toBeTruthy();
  expect(getByText("google-drive/search_files")).toBeTruthy();
  expect(
    getByText("Nothing is saved until you press the button."),
  ).toBeTruthy();
  expect(getByRole("button", { name: "Create it" })).toBeTruthy();
});

test("pressing create saves the checked fields, then resumes the run", async () => {
  const saved: unknown[] = [];
  const answers: unknown[] = [];
  const { getByRole } = render(
    <ProposedSkillCard
      args={DRAFT}
      respond={async (result) => {
        answers.push(result);
      }}
      save={async (values) => {
        saved.push(values);
      }}
    />,
  );

  await userEvent.click(getByRole("button", { name: "Create it" }));

  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toEqual(DRAFT);
  // Saved first, answered second: a run resumed before the write lands would be told about a skill
  // that does not exist yet.
  await waitFor(() => expect(answers).toHaveLength(1));
  expect(answers[0]).toBe(skillCardAnswer.saved("weekly-summary"));
});

test("a slug that already exists is offered as a replacement, not a create", () => {
  const { getByRole, getByText } = render(
    <ProposedSkillCard
      args={DRAFT}
      replaces={{ ownership: "yours", title: "Weekly summary" }}
      respond={async () => {}}
      save={async () => {}}
    />,
  );

  // Saving is how an edit is spelled here, so the wording has to say which one this press is.
  expect(getByRole("button", { name: "Replace it" })).toBeTruthy();
  expect(getByText(/This replaces Weekly summary/)).toBeTruthy();
});

test("a refusal from the server stays on the card and leaves the run suspended", async () => {
  const answers: unknown[] = [];
  const { getByRole, getByText } = render(
    <ProposedSkillCard
      args={DRAFT}
      respond={async (result) => {
        answers.push(result);
      }}
      save={async () => {
        throw new Error("weekly-summary is somebody else's skill.");
      }}
    />,
  );

  await userEvent.click(getByRole("button", { name: "Create it" }));

  // The server's own sentence, because paraphrasing it throws away the only part worth reading.
  await waitFor(() =>
    expect(getByText("weekly-summary is somebody else's skill.")).toBeTruthy(),
  );
  // Not answered: the two useful next moves — press again, or decline — both need the run still there.
  expect(answers).toHaveLength(0);
  expect(getByRole("button", { name: "Create it" })).toBeTruthy();
});

test("declining answers the run and tells the Bot to ask rather than retry", async () => {
  const answers: unknown[] = [];
  const saved: unknown[] = [];
  const { getByRole } = render(
    <ProposedSkillCard
      args={DRAFT}
      respond={async (result) => {
        answers.push(result);
      }}
      save={async () => {
        saved.push(1);
      }}
    />,
  );

  await userEvent.click(getByRole("button", { name: "Don't save" }));

  await waitFor(() => expect(answers).toHaveLength(1));
  expect(answers[0]).toBe(skillCardAnswer.declined());
  expect(saved).toHaveLength(0);
});

test("a draft the fields refuse answers once with the problems, and never asks the person", async () => {
  const answers: unknown[] = [];
  const saved: unknown[] = [];
  const card = (
    <ProposedSkillCard
      args={{ slug: "Weekly Summary", title: "Weekly", instructions: "Go." }}
      respond={async (result) => {
        answers.push(result);
      }}
      save={async () => {
        saved.push(1);
      }}
    />
  );
  const { rerender, queryByRole } = render(card);

  await waitFor(() => expect(answers).toHaveLength(1));
  expect(String(answers[0])).toContain("slug:");
  expect(saved).toHaveLength(0);
  // Nothing to decide, so nothing is offered.
  expect(queryByRole("button")).toBeNull();

  /*
   * THE REGRESSION THIS HOLDS DOWN. The problems are rebuilt from the arguments on every render and
   * the grant queries behind this card poll, so a value-equal array arrives as a new identity every
   * few seconds. Left to the effect's dependency list, this answered the same tool call again on each
   * of them, resuming a turn that had already moved on.
   */
  for (let index = 0; index < 3; index++) rerender(card);
  expect(answers).toHaveLength(1);
});
