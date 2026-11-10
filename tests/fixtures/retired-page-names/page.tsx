// A sample the retired-names scan must flag four times and pass three times. Never compiled.
export const NAVIGATION = [
  { id: "capabilities", label: "Capabilities" },
  { id: "bots", label: "Bots" },
];

export function Page({ personal }: { personal: boolean }) {
  return (
    <>
      <PageShell title="Goals" description="A goal is something to reach." />
      <BotSubpage title={personal ? "What it can do" : "Approvals"} />
      <ItemTitle>Saved logins</ItemTitle>
      <ItemTitle>Automatic learning</ItemTitle>
      <p>Goals and check-ins are routines.</p>
    </>
  );
}
