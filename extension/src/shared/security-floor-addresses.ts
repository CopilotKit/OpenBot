/**
 * Where the Recorder reads the security floor (shared/security-floor.ts), in order: beside the
 * update feed on downloads.copilotkit.ai, then on the Latest GitHub release. Kept here, never in
 * shared/, which every self-hosted OpenBot ships. tests/security-floor-addresses.test.ts holds it
 * equal to OpenBot Mobile's and OpenBot Desktop's.
 */
export const SECURITY_FLOOR_ADDRESSES: readonly string[] = [
  "https://downloads.copilotkit.ai/latest/security-floor.json",
  "https://github.com/CopilotKit/OpenBot/releases/latest/download/security-floor.json",
];
