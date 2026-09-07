const configuredPort =
  typeof __OPENBOT_SERVER_PORT__ === "string" ? __OPENBOT_SERVER_PORT__ : "";

export function socketUrl(
  path: string,
  location: {
    protocol: string;
    hostname: string;
    host: string;
  } = window.location,
  port: string = configuredPort,
): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const authority = port ? `${location.hostname}:${port}` : location.host;
  return `${scheme}//${authority}${path}`;
}
