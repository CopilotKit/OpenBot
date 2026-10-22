import { expect, test } from "bun:test";
import {
  AUTHORIZATION_NOTICES,
  authorizationNoticeFor,
  Route,
} from "@/routes/_authed/_app/connections.index";

/**
 * The notice channel the brokered per-action verifier reports back on, decided without drawing
 * anything.
 *
 * THE SENTENCE LIVES HERE AND THE URL CARRIES ONLY A CODE, which is the whole point of the channel.
 * A message rendered from a query string is a message anybody can author on this deployment's own
 * origin: a link could be passed around carrying whatever sentence its author liked, shown in this
 * page's voice under this deployment's address. So the server chooses from a closed set of opaque
 * codes and this map is the only place one becomes words — which is also what stops a sentence
 * being maintained in two places that drift.
 *
 * A `.tsx` file because it imports a route module, which is JSX; the precedent is
 * `connected-accounts-list.test.tsx`, which exports its own rule as a function for this reason.
 */

/**
 * THE SAME CLOSED SET THE SERVER HOLDS, asserted as a set here too. The server's own suite asserts
 * `AUTHORIZATION_REFUSALS` against this same list, so a code added on one side without the other
 * turns one of the two red: a new code with no sentence would otherwise draw nothing at all.
 */
test("every reason the verifier can send has a sentence here, and no others", () => {
  expect([...AUTHORIZATION_NOTICES.keys()]).toEqual([
    "no-broker",
    "not-supported",
    "missing-handle",
    "no-attempt",
    "vendor-unavailable",
    "not-your-authorization",
    "not-finished",
    "authorization-failed",
    "context-changed",
    "not-permitted",
    "cancelled",
    "cancelled-left-live",
    "not-recorded",
  ]);
});

test("each code reads as its own sentence, not as one generic apology", () => {
  const sentences = [...AUTHORIZATION_NOTICES.values()];
  expect(new Set(sentences).size).toBe(sentences.length);
  for (const sentence of sentences) {
    // Long enough to say what happened and what to do about it, rather than an apology.
    expect(sentence.length).toBeGreaterThan(60);
  }
});

test("a code is turned into the words for it", () => {
  expect(authorizationNoticeFor("no-attempt")).toBe(
    AUTHORIZATION_NOTICES.get("no-attempt") as string,
  );
});

/**
 * AND A CODE THIS BUILD DOES NOT KNOW DRAWS NOTHING, deliberately. Such a code is either somebody
 * probing the parameter or a deployment mid-upgrade; a generic "something went wrong" for both
 * would tell a person nothing and invite them to keep trying.
 */
test("an unrecognised or absent code draws nothing", () => {
  expect(authorizationNoticeFor("something-somebody-made-up")).toBeNull();
  expect(authorizationNoticeFor("")).toBeNull();
  expect(authorizationNoticeFor(undefined)).toBeNull();
});

/** The sentence never travels in the URL, so nothing in the map may be read out of one. */
test("the notices are not reachable from the search parameter's own value", () => {
  expect(
    authorizationNoticeFor("That account could not be connected."),
  ).toBeNull();
});

/**
 * AND A CODE BORROWED FROM `Object.prototype` DRAWS NOTHING EITHER, which is a different claim
 * from the one above and was once false.
 *
 * `?authorized=toString` is not a code the verifier can send, but it is a member every plain
 * object inherits. A lookup that walks the prototype chain answers it with a function — not
 * nullish, so no `?? null` catches it — and the page then hands a function, or for `__proto__` an
 * object, to React as the notice to draw: an empty red alert for `constructor`, and for `__proto__`
 * "Objects are not valid as a React child", which takes the whole screen down. A crafted link on
 * this deployment's own origin broke Connected accounts for whoever opened it.
 */
test.each([
  ["toString", "a function React draws as nothing it can read"],
  ["constructor", "a function, drawn as an empty red alert"],
  ["__proto__", "an object, which crashes the screen React draws it on"],
  ["valueOf", "a function"],
  ["hasOwnProperty", "a function"],
])(
  "%s is a borrowed member, not a code, and draws nothing (%s)",
  (borrowed) => {
    expect(authorizationNoticeFor(borrowed)).toBeNull();
  },
);

/** The declared `string | null` holds for every value a URL can carry, not only the known codes. */
test.each([
  "no-attempt",
  "toString",
  "constructor",
  "__proto__",
  "something-somebody-made-up",
])(
  "what ?authorized=%s answers is a sentence or nothing, never a function or an object",
  (value) => {
    const notice = authorizationNoticeFor(value);
    if (notice !== null) expect(typeof notice).toBe("string");
  },
);

/**
 * AND THE CODE REACHES THAT LOOKUP AT ALL, whatever the router parsed the parameter into.
 *
 * Search values are JSON-parsed, so a reason code or server key made of digits arrives as a number
 * and a JSON-shaped one as an object. All three parameters on this screen are read as text
 * (`searchText`), so what the callback reported is what the screen decides on rather than silently
 * nothing at all.
 */
test("every parameter on this screen is read as text, whatever it parsed into", () => {
  const validate = Route.options.validateSearch as (s: unknown) => object;
  expect(
    validate({ connected: 12345, authorized: 678, linked: { a: 1 } }),
  ).toEqual({ connected: "12345", authorized: "678", linked: '{"a":1}' });
  expect(validate({ authorized: "no-attempt" })).toEqual({
    authorized: "no-attempt",
  });
  expect(validate({})).toEqual({});
});
