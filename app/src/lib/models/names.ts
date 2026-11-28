/**
 * A model as a person reads it: the name its provider gives it ("GPT-4.1 Mini"), never the id a run
 * sends (`openai/gpt-4.1-mini`).
 *
 * The allowlist, a team's list, the usage view and the trail all keep a model as `provider/model`.
 * Each screen that shows one names it from a listing it already reads: the catalogue (what the
 * person picks from) or, in Admin, the whole listing (`view=all`). A model no listing has (a remote
 * Bot's own, or one the provider stopped listing) has no other name, so its id is what is shown.
 */
type Listing = {
  provider: string;
  models: readonly { id: string; label: string }[];
};

/** A model's name, by its `provider/model` id, from the first listing that has it. */
export function modelNamer(
  ...listings: (Listing | null | undefined)[]
): (name: string) => string {
  return (name) => {
    for (const listing of listings) {
      const found = listing?.models.find(
        (model) => `${listing.provider}/${model.id}` === name,
      );
      if (found) return found.label;
    }
    return name;
  };
}

/** A model's name by the id a listing knows it by inside its own provider (`gpt-4.1-mini`). */
export function modelLabel(listing: Listing, id: string): string {
  return listing.models.find((model) => model.id === id)?.label ?? id;
}
