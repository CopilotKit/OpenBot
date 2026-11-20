/**
 * Whether an address is this machine's own, and whether a deployment says it is reached from beyond it.
 *
 * Shared because three processes ask: the server, deciding whether single-user mode admits a caller,
 * and the app's two servers (`app/serve.ts`, Vite), deciding which interfaces to listen on. They must
 * give the same answer. A proxy that listens on every interface in front of a server that admits only
 * this machine's callers hands the LAN a loopback connection, and the server cannot tell it apart.
 */

/**
 * A host name or address that can only mean this machine: `localhost`, 127.0.0.0/8 and `::1`.
 *
 * Takes a URL's hostname (`[::1]` with its brackets) or a socket's address (`::1`, and `::ffff:127.0.0.1`,
 * which is how a dual-stack socket reports an IPv4 caller). `*.localhost` is not included: a browser
 * resolves it to loopback by itself, but anything else asks DNS.
 */
export function isLoopbackHost(raw: string): boolean {
  const bare = raw
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (bare === "localhost") return true;
  if (isLoopbackV4(bare)) return true;
  if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") return true;
  // An IPv4 address carried in IPv6: a dual-stack socket reports `::ffff:127.0.0.1`, and a URL parser
  // rewrites the same address as `::ffff:7f00:1`.
  const mapped = /^(?:0:0:0:0:0:|::)ffff:(.+)$/.exec(bare);
  if (mapped?.[1]) {
    const tail = mapped[1];
    if (isLoopbackV4(tail)) return true;
    const hex = /^([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(tail);
    return hex?.[1] !== undefined && Number.parseInt(hex[1], 16) >> 8 === 0x7f;
  }
  return false;
}

function isLoopbackV4(value: string): boolean {
  const octets = value.split(".");
  return (
    octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    octets[0] === "127"
  );
}

/** A literal IPv4 or IPv6 address, as a URL's hostname or a Host header carries it, rather than a name. */
export function isAddressLiteral(raw: string): boolean {
  const bare = raw.trim().toLowerCase();
  if (bare.startsWith("[") && bare.endsWith("]")) return bare.includes(":");
  const octets = bare.split(".");
  return (
    octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** The settings that say where a deployment is reached from: the server's own, and where its app is served. */
const ADDRESS_SETTINGS = [
  "OPENBOT_PUBLIC_URL",
  "OPENBOT_APP_URL",
  "BETTER_AUTH_URL",
] as const;

/** Every address the deployment's settings say it is reached at, as written: the URLs and `TRUSTED_ORIGINS`. */
export function deploymentAddresses(
  environment: Record<string, string | undefined>,
): string[] {
  return [
    ...ADDRESS_SETTINGS.map((name) => environment[name]?.trim()),
    ...(environment.TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((part) => part.trim()),
  ].filter((value): value is string => Boolean(value));
}

/**
 * Each address the deployment's settings name that is not this machine's, as written.
 *
 * Empty means every address it is reached at is loopback, or none is configured, which is a deployment
 * only the person at this machine uses. A value that does not parse counts as beyond: an address nobody
 * could read is not one anybody checked.
 */
export function addressesBeyondThisMachine(
  environment: Record<string, string | undefined>,
): string[] {
  return deploymentAddresses(environment).filter((value) => {
    try {
      return !isLoopbackHost(new URL(value).hostname);
    } catch {
      return true;
    }
  });
}

/**
 * Where the app's own servers (`app/serve.ts`, Vite) listen: this machine's two loopbacks, unless the
 * deployment names an address beyond it.
 *
 * Both of those servers pass `/api` to the API server from this machine, so whoever reaches them reaches
 * the API as a caller on this machine. Listening on every interface handed that to anybody on the same
 * network. A deployment that names an address on its network (`OPENBOT_APP_URL=http://192.168.1.10:3010`)
 * is saying other machines reach it, and gets every interface as before.
 */
export function appListenHosts(
  environment: Record<string, string | undefined>,
): string[] {
  return addressesBeyondThisMachine(environment).length > 0
    ? ["::"]
    : ["127.0.0.1", "::1"];
}
