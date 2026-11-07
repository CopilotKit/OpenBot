export function BotHarness({ name }: { name?: string }) {
  if (!name) return null;
  return <p className="text-muted-foreground text-xs">Powered by {name}</p>;
}
