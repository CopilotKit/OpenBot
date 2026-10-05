import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionFields } from "@/components/plugins/connection-fields";
import type { BrokerField } from "@/lib/plugins/mutations";
import { BROKER_FIELD_KEYS } from "../../server/src/plugins/broker";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/**
 * The form one app's published fields are drawn into, and the names in it are the VENDOR's.
 *
 * THE HARNESS IS `button-native.test.tsx`'s, which is the lightest one here: `GlobalRegistrator` in
 * `beforeAll`/`afterAll`, `cleanup` in `afterEach`, and queries off `render()`'s own return. This
 * component takes no router and no query client — it is a list of inputs and a submit — so nothing
 * else is wrapped around it.
 *
 * WHAT IS UNDER TEST IS THE SAME CONCERN THE SERVER SIDE OF THIS FLOW WAS CORRECTED FOR: a name
 * Composio chose is used here as a key into the object holding what somebody has typed, and a plain
 * object answers for names nobody put in it. The list is re-published on every open, so the carrying
 * over of typed values across a new list is exactly where that read happens.
 */
const API_KEY: BrokerField = {
  name: "api_key",
  label: "API key",
  help: "Your Firecrawl API key, a token starting with fc-",
  required: true,
  secret: true,
};

/** A field named after something every object already answers for, with a default of its own. */
const RENDERING: BrokerField = {
  name: "toString",
  label: "Rendering",
  help: "How this account names itself.",
  required: false,
  secret: false,
  default: "plain",
};

test("a newly published box named toString is filled with its default, not with a function", async () => {
  /*
   * THE READ THAT GOES WRONG IS `held[field.name]` ON A LIST THAT HAS JUST CHANGED. The dialog asks
   * the app what it wants on every open and hands this form the answer while it is already mounted,
   * so a field the app has only just started publishing is looked up in values that never held it —
   * and `held["toString"]` is not `undefined` on a plain object, it is the function hanging off
   * `Object.prototype`. Read as somebody's typing, it survives into the values, is drawn into the
   * box, and is submitted under a name the app really does read.
   */
  const submissions: Record<string, string>[] = [];
  const submit = (values: Record<string, string>) => {
    submissions.push(values);
  };

  const { container, getByLabelText, rerender } = render(
    <ConnectionFields busy={false} fields={[API_KEY]} onSubmit={submit} />,
  );

  /*
   * TYPED RATHER THAN SET. The box is a Base UI input, which reads a keystroke and not a `change`
   * event dispatched at the element, so `fireEvent.change` moves the DOM value and leaves this
   * form's own state where it was — which would make the assertion below pass on nothing.
   */
  await userEvent.type(getByLabelText("API key"), "fc-live-a-secret");

  // The same dialog, a moment later, holding what the app publishes now.
  rerender(
    <ConnectionFields
      busy={false}
      fields={[API_KEY, RENDERING]}
      onSubmit={submit}
    />,
  );

  /*
   * THE BOX ITSELF, WHICH IS WHAT THE PERSON IS LOOKING AT. `getByLabelText` also asserts the label
   * still points at its own input — the ids these draw from are the vendor's names, so they are
   * namespaced rather than used as document-wide ids, and a label that stopped finding its box
   * would be that namespacing applied to one of the two and not the other.
   */
  const rendering = getByLabelText("Rendering") as HTMLInputElement;
  expect(rendering.value).toBe("plain");

  const form = container.querySelector("form");
  if (form === null) throw new Error("the form was not drawn");
  fireEvent.submit(form);

  // What was typed, and the new box's own default beside it — nothing that came off a prototype.
  expect(submissions).toEqual([
    { api_key: "fc-live-a-secret", toString: "plain" },
  ]);
});

/**
 * A name every object already answers for, published with no default, so a keystroke is all it has.
 *
 * `__proto__` FAILS THE OTHER WAY FROM `toString`, AND ONLY ONE OF THE TWO PROTECTIONS CATCHES IT.
 * Reading `toString` off a plain object hands back a function, which the reconcile below refuses by
 * going through a `Map`; assigning `__proto__` on a plain object reaches the prototype setter,
 * which ignores a string — so the value is dropped between the keystroke and the request, and no
 * read anywhere can recover it. Only the bag having no prototype keeps it.
 */
const PROXY: BrokerField = {
  name: "__proto__",
  label: "Proxy",
  help: "The gateway this account is reached through.",
  required: false,
  secret: false,
};

test("what somebody types into a box named __proto__ is what gets submitted", async () => {
  /*
   * THE PROTECTION THIS PINS ON ITS OWN IS `bagOf`'s NULL PROTOTYPE. The test above covers both
   * protections at once and passes with either one of them removed — a name answered off
   * `Object.prototype` is refused by the bag having no prototype AND by {@link reconcile} reading
   * through maps, so neither was held by anything on its own. Nothing is re-published here, so
   * `reconcile` never runs and cannot answer for this one: a plain object silently drops this
   * assignment, and what the person typed never leaves the form.
   */
  const submissions: Record<string, string>[] = [];
  const submit = (values: Record<string, string>) => {
    submissions.push(values);
  };

  const { container, getByLabelText } = render(
    <ConnectionFields
      busy={false}
      fields={[API_KEY, PROXY]}
      onSubmit={submit}
    />,
  );

  await userEvent.type(getByLabelText("API key"), "fc-live-a-secret");
  await userEvent.type(getByLabelText("Proxy"), "gateway.example.test");

  // The box itself, because a value the bag dropped is also a box that stays empty under a cursor.
  expect((getByLabelText("Proxy") as HTMLInputElement).value).toBe(
    "gateway.example.test",
  );

  const form = container.querySelector("form");
  if (form === null) throw new Error("the form was not drawn");
  fireEvent.submit(form);

  /*
   * READ AS ENTRIES RATHER THAN COMPARED WITH A LITERAL, because `__proto__` written as a key in an
   * object literal is the prototype rather than a key — the expectation would decide what it means
   * to assert. `Object.entries` asks the submitted bag what it actually holds.
   */
  expect(submissions).toHaveLength(1);
  expect(Object.entries(submissions[0])).toEqual([
    ["api_key", "fc-live-a-secret"],
    ["__proto__", "gateway.example.test"],
  ]);
});

test("a box named __proto__ nobody touched takes the default the app publishes now", async () => {
  /*
   * AND THIS IS THE PROTECTION THE ONE ABOVE CANNOT ANSWER FOR: {@link reconcile} reading both
   * sides through maps. "Nobody typed this" is decided by comparing what is held against what the
   * PREVIOUS list seeded, and that second lookup is by field name — so a plain object holding the
   * previous defaults answers `Object.prototype` for this name rather than the default it was
   * given. Nothing then equals anything, the field reads as somebody's own typing, and a default
   * the vendor has just changed is pinned to yesterday's value with nothing to notice it.
   */
  const submissions: Record<string, string>[] = [];
  const submit = (values: Record<string, string>) => {
    submissions.push(values);
  };

  const { container, getByLabelText, rerender } = render(
    <ConnectionFields
      busy={false}
      fields={[API_KEY, { ...PROXY, default: "gateway.example.test" }]}
      onSubmit={submit}
    />,
  );

  await userEvent.type(getByLabelText("API key"), "fc-live-a-secret");

  // The same dialog a moment later, with the app publishing a different gateway.
  rerender(
    <ConnectionFields
      busy={false}
      fields={[API_KEY, { ...PROXY, default: "edge.example.test" }]}
      onSubmit={submit}
    />,
  );

  expect((getByLabelText("Proxy") as HTMLInputElement).value).toBe(
    "edge.example.test",
  );

  const form = container.querySelector("form");
  if (form === null) throw new Error("the form was not drawn");
  fireEvent.submit(form);

  expect(submissions).toHaveLength(1);
  expect(Object.entries(submissions[0])).toEqual([
    ["api_key", "fc-live-a-secret"],
    ["__proto__", "edge.example.test"],
  ]);
});

/**
 * Every key the SERVER publishes on one of these fields, READ OFF THE SERVER'S OWN DECLARATION.
 *
 * `BROKER_FIELD_KEYS` in `server/src/plugins/broker.ts` is pinned to `BrokerField` in both
 * directions — `satisfies` holds the list inside the shape and a `Decides<…>` witness holds the
 * shape inside the list — so this import is the server's key set and not a reading of it.
 *
 * IT WAS A HAND COPY FOR TWO ROUNDS AND THAT IS WHY IT IS NOT ONE NOW. The copy was defended as
 * `SERVER_FIELD_SCHEMES` in `brokered-account-row.test.tsx` is defended, and the defence does not
 * carry: that roster earns its copy by deliberately holding a scheme the screen has NEVER heard of,
 * which is a disagreement only a copy can state. This one stated no disagreement. It was a literal
 * compared against `EVERY_KEY`, a second literal in this same file, so a key added to the real
 * `BrokerField` at the server passed both sides of a test whose own prose claimed to count the
 * server's declaration against the browser's.
 *
 * IMPORTING IT COSTS THIS FILE NOTHING AT RUNTIME. `broker.ts` imports nothing — not the vendor's
 * package, not a type from elsewhere in the tree — which is a property that module's own header
 * declares and keeps, so crossing the seam here pulls in one file of names.
 */
const SERVER_BROKER_FIELD_KEYS = BROKER_FIELD_KEYS;

/**
 * One field carrying a value for every key on that roster, as an app publishing the lot would.
 *
 * `Required<BrokerField>` is the browser's own declaration asked to accept it. That is a statement
 * rather than a guarantee HERE — `app/tsconfig.json` covers `src` and not `app/tests`, and
 * `bun test` does not typecheck, which the sibling file records at its own `accountState` — so the
 * bite is the pair of counts at the end of the test: the keys of this object against the server's
 * roster, and that roster against the list of things the form is observed to DO with a key. Both
 * counts run against {@link SERVER_BROKER_FIELD_KEYS}, which is the server's own value and not a
 * copy of it, so neither is satisfied by this file agreeing with itself.
 */
const EVERY_KEY: Required<BrokerField> = {
  name: "firecrawl_api_key",
  label: "Firecrawl API key",
  help: "Your Firecrawl API key, a token starting with fc-",
  required: true,
  secret: true,
  default: "fc-paste-yours-here",
};

/**
 * The same shape with the optional key left out and both flags the other way.
 *
 * A SECOND FIELD BECAUSE ONE FIELD CANNOT SHOW A FLAG IS READ. With only the field above,
 * `required` and `secret` are satisfied by a form that hard-codes every box as a required password,
 * and `default` by one that never clears a value — three guards passing on a constant. The pair is
 * what makes each of the three answer for itself.
 */
const NOTHING_SET: BrokerField = {
  name: "base_url",
  label: "Base URL",
  help: "",
  required: false,
  secret: false,
};

test("the form reads every key the server publishes on a field", () => {
  const submissions: Record<string, string>[] = [];
  const { container, getByLabelText, queryByText } = render(
    <ConnectionFields
      busy={false}
      fields={[EVERY_KEY, NOTHING_SET]}
      onSubmit={(values) => submissions.push(values)}
    />,
  );

  const set = getByLabelText(EVERY_KEY.label) as HTMLInputElement;
  const unset = getByLabelText(NOTHING_SET.label) as HTMLInputElement;
  const form = container.querySelector("form");
  if (form === null) throw new Error("the form was not drawn");
  fireEvent.submit(form);

  /**
   * What the browser is observed to do with each key, one entry per key of the server's roster.
   *
   * KEYED ON THE SERVER'S NAMES SO THE SET CAN BE COUNTED, which is the whole of the lever. A key
   * the server starts publishing is a key with no entry here, and the comparison at the end fails
   * on the roster rather than leaving the new value silently unread on its way to a form.
   */
  const readByTheForm: Record<string, () => void> = {
    /*
     * The vendor's name, used as the id tying the label to its own box AND as the key the value
     * goes back under. Both, because a box drawn under a name nothing submits is exactly what
     * `connectionFields`' own name guard exists to prevent, one layer up.
     */
    name: () => {
      expect(set.id.endsWith(`-${EVERY_KEY.name}`)).toBe(true);
      expect(unset.id.endsWith(`-${NOTHING_SET.name}`)).toBe(true);
      expect(submissions).toEqual([
        { [EVERY_KEY.name]: EVERY_KEY.default, [NOTHING_SET.name]: "" },
      ]);
    },
    /** The words on the box, which is what `getByLabelText` found each of them by. */
    label: () => {
      expect(set).toBeTruthy();
      expect(unset).toBeTruthy();
    },
    /*
     * The app's own instructions, drawn where there are any and nowhere invented where there are
     * none — an empty string is a field publishing no sentence, not a row missing its description.
     */
    help: () => {
      expect(queryByText(EVERY_KEY.help)).toBeTruthy();
      expect(
        container.querySelectorAll("[data-slot='item-description']").length,
      ).toBe(1);
    },
    /*
     * The flag that stops the form. Read as a no, a credential the app cannot do without becomes a
     * box somebody may leave blank.
     */
    required: () => {
      expect(set.required).toBe(true);
      expect(unset.required).toBe(false);
    },
    /** The flag that masks the box. Read as a no, somebody's API key is typed in plain sight. */
    secret: () => {
      expect(set.type).toBe("password");
      expect(unset.type).toBe("text");
    },
    /** The value the box opens with, and the empty string where the app published none. */
    default: () => {
      expect(set.value).toBe(EVERY_KEY.default);
      expect(unset.value).toBe("");
    },
  };

  /*
   * THE TWO COUNTS, WHICH ARE THE DRIFT TEST ITSELF. The first says the browser's own declaration
   * carries the server's keys and no others; the second says every one of those keys has something
   * on this side reading it. A key added at either end passes neither by accident.
   */
  expect(Object.keys(EVERY_KEY).sort()).toEqual(
    [...SERVER_BROKER_FIELD_KEYS].sort(),
  );
  expect(Object.keys(readByTheForm).sort()).toEqual(
    [...SERVER_BROKER_FIELD_KEYS].sort(),
  );

  for (const read of Object.values(readByTheForm)) read();
});
