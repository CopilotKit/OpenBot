/**
 * The organization the signed-in person is working in, read once per sign-in.
 *
 * A person can belong to several organizations, and picks the one they work in on the phone (the switcher on Home).
 * Their pick is kept on the phone, so it is still theirs after the app is opened again. Until they pick, it is the
 * server's answer: the active one in the list of their own, else the one they joined first. A pick that is no longer
 * in their list (they left it, it was deleted, or somebody else signed in on this phone) is not used. Every request the
 * API addresses by organization goes to it, and every request names it (`OpenBot-Organization`). It imports nothing,
 * so it can be tested without a phone.
 */

export type ListedOrganization = {
  id: string;
  name?: string;
  active?: boolean;
};

/** What somebody in no organization is told. */
export const IN_NO_ORGANIZATION =
  "You aren't a member of an organization here. Ask an admin to add you.";

/** What somebody picking an organization they are not in is told. */
export const NOT_IN_ORGANIZATION =
  "You aren't a member of that organization any more.";

/** The path every address under an organization starts with, before the organization is filled in. */
export const ORGANIZATION = "/api/v2/organizations/{organizationId}";

/** The header that names the organization a request is for, on every request a signed-in person makes. */
export const ORGANIZATION_HEADER = "OpenBot-Organization";

/**
 * Where each person's pick is kept on the phone, by who they are (`person`, their account's id): a phone shared by
 * several people opens in each one's own pick. Reading may answer null: nothing picked yet.
 */
export type OrganizationStore = {
  read(person: string): Promise<string | null>;
  write(person: string, id: string): Promise<void>;
};

/** A phone that keeps nothing: the server's answer every time. */
const NOTHING_KEPT: OrganizationStore = {
  read: async () => null,
  write: async () => {},
};

/** The one the person is working in: the one they picked, while it is theirs, else the active one, else the first. */
export function workingIn(
  organizations: ListedOrganization[],
  picked?: string | null,
): string {
  const found =
    (picked ? organizations.find((one) => one.id === picked) : undefined) ??
    organizations.find((one) => one.active) ??
    organizations[0];
  if (!found) throw new Error(IN_NO_ORGANIZATION);
  return found.id;
}

/** The person's organizations, and the one they are working in. */
export type OrganizationChoices = {
  organizations: ListedOrganization[];
  currentId: string;
};

/**
 * The person's organizations and the one they work in, for whoever is signed in. `list` reads their organizations,
 * and is asked once for each sign-in (`signedInAs` is whatever tells one sign-in from another) and each person
 * (`person`, who the sign-in client says is signed in, unknown until it has said). A read that fails is asked again.
 * `store` keeps each person's pick on the phone; with nobody known yet, there is no pick to read or keep.
 */
export function createOrganizationChoice(
  list: () => Promise<ListedOrganization[]>,
  store: OrganizationStore = NOTHING_KEPT,
  person: () => string | undefined = () => undefined,
) {
  let known:
    | { signedInAs: string; choices: Promise<OrganizationChoices> }
    | undefined;
  /** One sign-in, of one person. */
  const keyOf = (signedInAs: string) => `${person() ?? ""}\u0000${signedInAs}`;
  const picked = async (): Promise<string | null> => {
    const who = person();
    return who ? store.read(who).catch(() => null) : null;
  };

  function choices(signedInAs: string): Promise<OrganizationChoices> {
    const key = keyOf(signedInAs);
    if (known?.signedInAs !== key) {
      const read = Promise.all([list(), picked()]).then(
        ([organizations, picked]) => ({
          organizations,
          currentId: workingIn(organizations, picked),
        }),
      );
      known = { signedInAs: key, choices: read };
      read.catch(() => {
        if (known?.choices === read) known = undefined;
      });
    }
    return (known as { choices: Promise<OrganizationChoices> }).choices;
  }

  return {
    choices,

    /** The organization the person is working in. */
    async current(signedInAs: string): Promise<string> {
      return (await choices(signedInAs)).currentId;
    },

    /**
     * Work in `id` from now on, and keep that on the phone. Read again from the server first, so an organization the
     * person is no longer in is refused here and never addressed.
     */
    async choose(id: string, signedInAs: string): Promise<OrganizationChoices> {
      known = undefined;
      const { organizations } = await choices(signedInAs);
      if (!organizations.some((one) => one.id === id))
        throw new Error(NOT_IN_ORGANIZATION);
      const who = person();
      if (who) await store.write(who, id);
      const chosen = { organizations, currentId: id };
      known = {
        signedInAs: keyOf(signedInAs),
        choices: Promise.resolve(chosen),
      };
      return chosen;
    },

    /**
     * The organization `organizationId` answered that it isn't there for this person: they were removed from it, or it
     * was deleted. When it is the one they work in, what is known is forgotten, so the next request reads their
     * organizations again and works in another of theirs. Answers whether it was the one they work in.
     */
    async gone(organizationId: string, signedInAs: string): Promise<boolean> {
      const held = known;
      if (!held || held.signedInAs !== keyOf(signedInAs)) return false;
      const current = await held.choices.then(
        (chosen) => chosen.currentId,
        () => undefined,
      );
      if (current !== organizationId) return false;
      if (known === held) known = undefined;
      return true;
    },

    /** Fills the organization into a path that starts with {@link ORGANIZATION}; any other path is returned as it is. */
    async address(path: string, signedInAs: string): Promise<string> {
      if (!path.startsWith(ORGANIZATION)) return path;
      const id = (await choices(signedInAs)).currentId;
      return `/api/v2/organizations/${encodeURIComponent(id)}${path.slice(ORGANIZATION.length)}`;
    },
  };
}

/** {@link createOrganizationChoice}'s address alone, for a caller that only fills in addresses. */
export function createOrganizationAddress(
  list: () => Promise<ListedOrganization[]>,
) {
  return createOrganizationChoice(list).address;
}
