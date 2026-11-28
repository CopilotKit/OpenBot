/**
 * The `server.internalStatus` values the agent pins on the product release: the server's internal
 * status port on, and open to the agent's namespace, so the agent reads `/release` and the
 * collector `/metrics` without pods/exec. A chart without the setting ignores it.
 *
 * The agent's namespace goes in `managedAllowFrom`, never `allowFrom`. Flux, like Helm, replaces a
 * list from a later values source instead of merging it, and the pins are the last source, so a
 * pinned `allowFrom` would silently drop the customer's own peers (their Prometheus namespace, for
 * example). The chart admits the union of both lists.
 *
 * No imports, so the product chart's tests can render exactly what the agent pins.
 */
export function internalStatusPins(agentNamespace: string) {
  return {
    enabled: true,
    managedAllowFrom: [
      {
        namespaceSelector: {
          matchLabels: { "kubernetes.io/metadata.name": agentNamespace },
        },
      },
    ],
  };
}
