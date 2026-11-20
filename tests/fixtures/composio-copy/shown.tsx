// Read by tests/no-composio-in-user-copy.test.ts: five pieces of text a person reads, each naming
// the broker once, which the scan must catch.
const BROKERED_PROFILE = { composio: { vendor: "Composio" } };
export const said = "Browse Composio";
export const reached = `Reached through ${BROKERED_PROFILE.composio.vendor}.`;
export const waiting = `Apps from Composio ${1}`;

export function Row() {
  return <p title="Through Composio">Composio holds the account</p>;
}
