/**
 * What the agent remembers, in one ConfigMap in its own namespace, so a restarted agent carries on
 * where it was and a person can read and clear it with kubectl:
 *
 *   state.json    the release it accepted (manifest and chart digest), the one before, whether
 *                 it is paused, which commands it has already run, and the version its own first
 *                 install went to while none has been accepted
 *   journal.json  the last promotion, in the promotion tool's journal format
 *
 * A journal in any phase other than `accepted` or `failed` means a promotion stopped after it may
 * have changed the database. Nothing more is upgraded until a person has recovered and removed
 * journal.json:
 *
 *   kubectl -n openbot-system patch configmap openbot-agent-state --type=json \
 *     -p '[{"op":"remove","path":"/data/journal.json"}]'
 */
import { z } from "zod";
import type { PromotionJournal } from "../../shared/kubernetes-promotion";
import type { Kube } from "./kube";

const Release = z.strictObject({
  version: z.string(),
  /** The release manifest exactly as the management service sent it. */
  manifest: z.string(),
  /** The chart digest Flux was pinned to. */
  digest: z.string(),
});
export type AcceptedRelease = z.infer<typeof Release>;

const State = z.strictObject({
  accepted: Release.nullable(),
  previous: Release.nullable(),
  /** Paused by a signed command: nothing is upgraded until a signed resume. */
  paused: z.boolean(),
  /** The agent suspended the product's HelmRelease itself (pause), so resume may lift it. */
  suspendedByAgent: z.boolean(),
  /** A version rolled back from; not moved to again until the desired version changes. */
  rolledBackFrom: z.string().nullable(),
  /**
   * The version the agent's own first install went to, kept until a release is accepted. While it
   * is set and nothing is accepted, the product in the namespace is one the agent put there and
   * that never passed verification, so it holds no data to keep: once a person clears the journal,
   * the agent installs the desired release again rather than trying to adopt it.
   */
  firstInstall: z.string().nullable().default(null),
  handledCommands: z.array(z.string()).max(200),
});
export type AgentState = z.infer<typeof State>;

export const EMPTY_STATE: AgentState = {
  accepted: null,
  previous: null,
  paused: false,
  suspendedByAgent: false,
  rolledBackFrom: null,
  firstInstall: null,
  handledCommands: [],
};

/** Phases after which another promotion may start. */
export function journalBlocks(journal: PromotionJournal | null) {
  return journal !== null && !["accepted", "failed"].includes(journal.phase);
}

export class StateStore {
  constructor(
    private readonly kube: Kube,
    private readonly namespace: string,
    private readonly name: string,
  ) {}

  private async data() {
    const map = await this.kube.get<{ data?: Record<string, string> }>(
      this.namespace,
      "configmap",
      this.name,
    );
    return map?.data ?? {};
  }

  async read(): Promise<{
    state: AgentState;
    journal: PromotionJournal | null;
  }> {
    const data = await this.data();
    return {
      state: data["state.json"]
        ? State.parse(JSON.parse(data["state.json"]))
        : structuredClone(EMPTY_STATE),
      journal: data["journal.json"]
        ? (JSON.parse(data["journal.json"]) as PromotionJournal)
        : null,
    };
  }

  private write(data: Record<string, string>) {
    return this.kube.apply({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: this.name,
        namespace: this.namespace,
        labels: { "app.kubernetes.io/part-of": "openbot-agent" },
      },
      data,
    });
  }

  async saveState(state: AgentState) {
    const data = await this.data();
    await this.write({
      ...data,
      "state.json": `${JSON.stringify(State.parse(state), null, 2)}\n`,
    });
  }

  async saveJournal(journal: PromotionJournal) {
    const data = await this.data();
    await this.write({
      ...data,
      "journal.json": `${JSON.stringify(journal, null, 2)}\n`,
    });
  }
}
