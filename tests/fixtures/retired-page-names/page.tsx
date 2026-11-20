// A sample the retired-names scan must flag seven times and pass three times. Never compiled.
const HEADING = "Passwords";
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
      <ItemTitle>{"Keys"}</ItemTitle>
      <PageShell title={HEADING} />
      <LinkRow title="Approval rules" detail="What your Bots may do" />
      <LinkRow title="Approvals" label="Bots" />
      <p>Goals and check-ins are routines.</p>
    </>
  );
}
