/**
 * A positive number from the environment, or the fallback.
 *
 * `Number.parseInt(process.env.X ?? "default")` is not enough: an unset variable declared in a
 * compose file arrives as an empty string rather than as absent, so `??` never fires and the parse
 * yields `NaN`. Empty, absent, non-numeric and non-positive all mean "not set" and take the fallback.
 *
 * Its own module, free of the `playwright` import `profiles.ts` carries, so a test can reach it
 * without loading a browser driver that is not installed where the tests run.
 */
export function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
