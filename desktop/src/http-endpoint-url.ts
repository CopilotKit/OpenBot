export function isHttpEndpointUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.host.length > 0 &&
      // Some browser URL parsers preserve hostname spaces as percent escapes.
      !/\s/.test(decodeURIComponent(url.hostname))
    );
  } catch {
    return false;
  }
}
