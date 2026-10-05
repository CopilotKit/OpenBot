import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import type { BrokerField } from "@/lib/plugins/mutations";

/**
 * What one app asks for, drawn from what that app published.
 *
 * NOTHING HERE IS PER-APP KNOWLEDGE. The label, the help sentence, the masking and the pre-filled
 * default all come off the field, which came off Composio. An app this deployment has never heard of
 * draws correctly for the same reason Gmail does: Perplexity publishes one secret `generic_api_key`
 * whose help sentence says to look for a value starting with `pplx-`; Shopify publishes a plain
 * subdomain beside a secret admin token; Firecrawl publishes a base URL carrying a default most
 * people keep. All three are this list, with different rows in it.
 *
 * SO THERE IS NOTHING TO SWITCH ON. Across forty sampled apps every required field is a plain string
 * and the most any app asks for is three, and the server refuses anything that is not a string
 * before it reaches here — so this is a list of text inputs and deliberately nothing more. A field
 * type to branch on would be a second vocabulary to keep level with the vendor's, invented for a
 * shape nobody publishes.
 *
 * THE LIST CHANGES UNDER THIS FORM, WHICH IS WHY THE VALUES FOLLOW IT. The row that opens this asks
 * the app again on every open — the catalogue is the vendor's, and what an app wants typed in is
 * free to differ from what it wanted last time — but it opens holding the previous answer, so this
 * form is mounted on the old list and handed the new one a moment later. Seeded once, it would draw
 * today's rows over yesterday's values: a newly published field with its default missing, and a
 * retired field's name still in the values and still going up with the submission, which is the 400
 * that tells somebody their current form is not the current form.
 *
 * AND WHAT MAKES THAT TRUE IS NAMED, BECAUSE FOR A WHILE IT WAS NOT. "It opens holding the previous
 * answer" is a fact about `published` in `brokered-account-row.tsx` — the row keeps the last list
 * the app ANSWERED with, rather than reading the request that is asking again. Read off the request,
 * the list is null at exactly that moment: a mutation clears its own `data` as it fires, so the
 * dialog drew its waiting line, this component was not mounted at all, and every line below about
 * a list arriving under a mounted form described something that could not happen. The sentence
 * above was false for as long as that was how the list was read, and nothing failed — the values
 * were right, by the other route, and the reconcile they were argued for never ran.
 *
 * THE NAMES IN IT ARE THE VENDOR'S, AND THEY ARE KEYS HERE. Every name below was chosen by whoever
 * publishes the app at Composio, and this form uses each one three ways: as a key into the object
 * holding what somebody has typed, as the id tying a label to its box, and as React's key for the
 * row. None of the three may assume the name is safe or unique, which is the same care the connect
 * route takes with the submission it receives. The values live in a bag with no prototype, so a
 * field called `toString` is a name nobody has typed into rather than a function inherited from
 * `Object.prototype`; the ids are namespaced per mounted form rather than used as document-wide
 * ones; and the key is a name the server has already deduplicated — `ComposioBroker.connectionFields`
 * draws one box per name, so two rows here cannot share one.
 *
 * THE VALUES ARE HELD HERE AND IN THE REQUEST THAT CARRIES THEM, AND NOWHERE ELSE: no query cache,
 * no router state, no local storage. They are somebody's own key. This copy is the component's, so
 * it goes when the dialog closes; the mutation's copy is erased as its request settles, because a
 * mutation keeps the input it was called with for as long as its observer lives — see
 * `connectBrokeredWithFieldsMutationOptions` in `lib/plugins/mutations.ts`. Between them the key's
 * whole life here is the form somebody is filling in and the request it is sent in, which is the
 * most a credential we were only ever asked to forward may have.
 */
export function ConnectionFields({
  fields,
  onSubmit,
  busy,
}: {
  fields: BrokerField[];
  onSubmit: (values: Record<string, string>) => void;
  /** Whether the submission is already in flight, so the button cannot start a second one. */
  busy: boolean;
}) {
  /* Seeded from the defaults the app published, so a field most people keep is already filled in. */
  const [values, setValues] = useState<Record<string, string>>(() =>
    seed(fields),
  );
  /*
   * The list those values were last filled in against, kept so a new one can be told from a render.
   *
   * Adjusted during render rather than in an effect, which is what React asks for when state has to
   * follow a prop: the fix happens before this paint, so the new field is drawn with its default
   * already in it rather than drawn empty and corrected a frame later, under somebody's cursor.
   */
  const [published, setPublished] = useState<BrokerField[]>(fields);
  if (published !== fields) {
    setPublished(fields);
    setValues((held) => reconcile(fields, published, held));
  }

  /*
   * The prefix that makes each box's id this form's own rather than the document's.
   *
   * The id is what ties a label to its input, and it was the field's name — which is Composio's
   * text and not this deployment's, so it is free to be `title`, `description`, or the id of
   * something else on the page entirely. Two elements sharing an id make the label point at
   * whichever came first, which is somebody typing their key into the wrong box.
   */
  const form = useId();

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(values);
      }}
    >
      {fields.map((field) => (
        /* `muted` rather than a card: `--card` and `--popover` are the same colour, so a
           card-coloured row inside a dialog is no row at all. */
        <Item key={field.name} variant="muted">
          <ItemContent>
            <ItemTitle>
              <label htmlFor={`${form}-${field.name}`}>{field.label}</label>
            </ItemTitle>
            {/* Unclamped: the app's own instructions are the point of the row, not a hint under it. */}
            {field.help ? (
              <ItemDescription className="line-clamp-none">
                {field.help}
              </ItemDescription>
            ) : null}
            <Input
              autoComplete="off"
              id={`${form}-${field.name}`}
              onChange={(event) =>
                setValues((held) => typed(held, field.name, event.target.value))
              }
              required={field.required}
              /* The app said which value is the secret; nothing here guesses from its name. */
              type={field.secret ? "password" : "text"}
              value={values[field.name] ?? ""}
            />
          </ItemContent>
        </Item>
      ))}
      <Button className="self-end" disabled={busy} size="sm" type="submit">
        {busy ? "Connecting…" : "Connect"}
      </Button>
    </form>
  );
}

/**
 * A bag of typed values holding exactly what was put in it, under the names it was given.
 *
 * THE NAMES ARE THE VENDOR'S, SO THE BAG HAS NO PROTOTYPE. A plain object answers for names nobody
 * ever typed into — `held.toString` and `held.constructor` come back as functions off
 * `Object.prototype` — and the read in {@link reconcile} cannot tell that from somebody's typing:
 * a field an app has only just started publishing would be carried into the values as a function,
 * drawn into its box, and submitted under a name the app really does read. `__proto__` fails the
 * other way, silently: assigning to it on a plain object reaches the prototype setter, which
 * ignores a string, so the value would be dropped between the keystroke and the request.
 *
 * The same bag the connect route builds its side of this submission in, for the same reason.
 */
function bagOf(entries: [string, string][]): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const [name, value] of entries) values[name] = value;
  return values;
}

/** One keystroke, as the whole bag again, so the object React holds is replaced rather than edited. */
function typed(
  held: Record<string, string>,
  name: string,
  value: string,
): Record<string, string> {
  return bagOf([...Object.entries(held), [name, value]]);
}

/** What a freshly published list of fields is worth before anybody has typed: its own defaults. */
function seed(fields: BrokerField[]): Record<string, string> {
  return bagOf(fields.map((field) => [field.name, field.default ?? ""]));
}

/**
 * The values for a list the app has just published, carrying over what somebody had typed.
 *
 * THE VALUES ARE EXACTLY THE NAMES THE APP PUBLISHES NOW. A name it has stopped publishing is
 * dropped rather than carried along, because the only thing left to happen to it is being sent, and
 * the server refuses the whole connection over a field the app does not ask for.
 *
 * AND A FIELD NOBODY TOUCHED TAKES TODAY'S DEFAULT. Untouched is knowable rather than guessed: a
 * value equal to what the previous list seeded is one this form put there, so the new list's answer
 * replaces it, and anything else is somebody's own typing and survives. That is what keeps this from
 * being a choice between losing a half-typed key and pinning a default the vendor has changed.
 *
 * AND "NOBODY TYPED THIS" IS READ OFF WHAT WAS TYPED RATHER THAN OFF ANY PROTOTYPE. This is the one
 * read in this file that asks for a name the values may never have held — a field is new here
 * precisely when the app has just started publishing it — so both lookups go through maps: `held`
 * through one built from its own entries, and the previous defaults through the one they were
 * already in. See {@link bagOf} for what the plain-object version of this read answered instead.
 */
function reconcile(
  next: BrokerField[],
  previous: BrokerField[],
  held: Record<string, string>,
): Record<string, string> {
  const seeded = new Map(
    previous.map((field) => [field.name, field.default ?? ""]),
  );
  const typedIn = new Map(Object.entries(held));
  return bagOf(
    next.map((field) => {
      const value = typedIn.get(field.name);
      const untouched = value === undefined || value === seeded.get(field.name);
      return [field.name, untouched ? (field.default ?? "") : value];
    }),
  );
}
