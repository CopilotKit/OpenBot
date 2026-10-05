/** Only the desktop shell's closed metadata may join the runtime's existing events. */
export function desktopTelemetryProperties(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (env.OPENBOT_DISTRIBUTION !== "desktop") return {};

  const properties: Record<string, string> = {
    openbot_distribution: "desktop",
  };
  for (const [input, output, allowed] of [
    [
      "OPENBOT_PLATFORM",
      "openbot_platform",
      ["macos", "windows", "linux", "other"],
    ],
    ["OPENBOT_ARCH", "openbot_arch", ["aarch64", "x86_64", "other"]],
    ["OPENBOT_ENGINE", "openbot_engine", ["docker", "podman", "none"]],
  ] as const) {
    const value = env[input];
    if (value && allowed.some((item) => item === value))
      properties[output] = value;
  }
  for (const [input, output] of [
    ["OPENBOT_VERSION", "openbot_version"],
    ["OPENBOT_OS_VERSION", "openbot_os_version"],
  ] as const) {
    const value = env[input];
    if (
      value &&
      value.length <= 32 &&
      value.trim() === value &&
      /^\d+(?:\.\d+){1,3}$/.test(value)
    ) {
      properties[output] = value;
    }
  }
  return properties;
}
