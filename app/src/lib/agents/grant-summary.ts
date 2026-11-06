/**
 * How widely something is granted, in words rather than a fraction.
 *
 * "0/3" needs decoding and reads as a score. The two ends are the ones worth recognising without
 * reading (nothing holds it, or everything does), so they are named, and the middle is the only
 * case that gets a number.
 */
export function grantSummary(held: number, total: number): string {
  if (held === 0) return "No Bots";
  if (held === total) return total === 1 ? "1 Bot" : "All Bots";
  return `${held} of ${total} Bots`;
}
