import {
  IconChevronRight,
  IconKey,
  IconPlug,
  IconWorld,
} from "@tabler/icons-react";
import { useState } from "react";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ALWAYS_ON_APP } from "@/lib/connections/rows";
import { ControlsSection } from "./controls-section";

/**
 * An address as the allowlist compares it, the way the server does (`normalizedServerAddress` in
 * `admin/controls.ts`): scheme, host and path, no trailing slash. Null for an entry that is a server
 * id rather than an address.
 */
export function listedAddress(entry: string): string | null {
  if (!URL.canParse(entry.trim())) return null;
  const url = new URL(entry.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * OpenBot's own apps, on for every Bot. The allowlist never holds them back, so their rows read on
 * and can't be switched.
 */
const ALWAYS_ON = new Set([ALWAYS_ON_APP, "openbot-settings"]);

/**
 * Admin, Apps: Connectors, the allowlist of the apps Bots may call tools on.
 *
 * WHAT EACH STATE SAYS. Off, every app can be used, so each app's switch reads on and can't be
 * changed: switching one would do nothing. Turning it on approves every app already added (the
 * server does it too, for every other way of saving the list), so nothing in use is cut off and
 * the admin turns off the ones they don't want. While it is on, an app an admin adds is approved
 * as it's added. An always-on app reads on in either state.
 */
export function McpAllowlistSection() {
  const [approving, setApproving] = useState(false);
  const [address, setAddress] = useState("");
  return (
    <ControlsSection
      description="While this is on, Bots can only use the connectors approved here, and a connector can only be added by its address once it's approved. Turning it on approves every connector already added, and each one an admin adds after that."
      title="Connectors"
    >
      {({ data, setSetting, saving }) => {
        const { mcpAllowlist } = data.settings;
        const limiting = mcpAllowlist.enabled;
        /*
         * Addresses approved before anybody added a server there. One already added is approved by
         * the same entry, so it is drawn on its server's row instead of twice.
         */
        const added = new Set(
          data.mcpServers
            .map((server) => listedAddress(server.url))
            .filter((value): value is string => value !== null),
        );
        const addresses = mcpAllowlist.servers.filter((entry) => {
          const normalized = listedAddress(entry);
          return normalized !== null && !added.has(normalized);
        });
        const approvedByAddress = (url: string) => {
          const normalized = listedAddress(url);
          return (
            normalized !== null &&
            mcpAllowlist.servers.some(
              (entry) => listedAddress(entry) === normalized,
            )
          );
        };
        const candidate = listedAddress(address);
        const approved = (server: { id: string; url: string }) =>
          mcpAllowlist.servers.includes(server.id) ||
          approvedByAddress(server.url);
        // Apps, then addresses nobody has added yet: what an admin reads as approved.
        const approvedCount =
          data.mcpServers.filter(
            (server) => !ALWAYS_ON.has(server.id) && approved(server),
          ).length + addresses.length;
        return (
          <>
            <PageRows>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconPlug />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Only approved connectors</ItemTitle>
                  <ItemDescription>
                    {limiting
                      ? `${approvedCount} approved`
                      : "Off. Bots can use every connector."}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label="Only approved connectors"
                    checked={limiting}
                    disabled={saving}
                    onCheckedChange={(enabled) =>
                      setSetting("mcpAllowlist", {
                        enabled,
                        /*
                         * Turned on, it starts with every app already added approved, so nothing in
                         * use is cut off. The server does the same whatever sends the list.
                         */
                        servers: enabled
                          ? [
                              ...mcpAllowlist.servers,
                              ...data.mcpServers
                                .filter(
                                  (server) =>
                                    !ALWAYS_ON.has(server.id) &&
                                    !approved(server),
                                )
                                .map((server) => server.id),
                            ]
                          : mcpAllowlist.servers,
                      })
                    }
                  />
                </ItemActions>
              </Item>
              {data.mcpServers.map((server) => {
                const alwaysOn = ALWAYS_ON.has(server.id);
                return (
                  <div key={server.id}>
                    <Separator />
                    <Item size="sm">
                      <ItemMedia variant="icon">
                        <IconKey />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{server.title}</ItemTitle>
                        <ItemDescription>
                          {alwaysOn ? "Always on, for every Bot." : server.url}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Switch
                          aria-label={`Approve ${server.title}`}
                          // Off, every app can be used; an always-on app, always.
                          checked={!limiting || alwaysOn || approved(server)}
                          disabled={saving || !limiting || alwaysOn}
                          onCheckedChange={(checked) =>
                            setSetting("mcpAllowlist", {
                              ...mcpAllowlist,
                              servers: checked
                                ? [...mcpAllowlist.servers, server.id]
                                : mcpAllowlist.servers.filter(
                                    (entry) =>
                                      entry !== server.id &&
                                      /*
                                       * An address entry at this app's address goes too. Only an
                                       * address: an id and a `composio://` app have none, and
                                       * comparing two nones took every id off the list.
                                       */
                                      (listedAddress(server.url) === null ||
                                        listedAddress(entry) !==
                                          listedAddress(server.url)),
                                  ),
                            })
                          }
                        />
                      </ItemActions>
                    </Item>
                  </div>
                );
              })}
              {addresses.map((entry) => (
                <div key={entry}>
                  <Separator />
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      <IconWorld />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{new URL(entry).host}</ItemTitle>
                      <ItemDescription>
                        Approved address. Not added yet.
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        disabled={saving}
                        onClick={() =>
                          setSetting("mcpAllowlist", {
                            ...mcpAllowlist,
                            servers: mcpAllowlist.servers.filter(
                              (value) => value !== entry,
                            ),
                          })
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Remove
                      </Button>
                    </ItemActions>
                  </Item>
                </div>
              ))}
              <Separator />
              <Item
                render={
                  <button onClick={() => setApproving(true)} type="button" />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconWorld />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Approve a connector by its address</ItemTitle>
                  <ItemDescription>
                    So people can add it from Connections.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </ItemActions>
              </Item>
            </PageRows>
            <Dialog
              onOpenChange={(open) => {
                setApproving(open);
                if (!open) setAddress("");
              }}
              open={approving}
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Approve a connector</DialogTitle>
                  <DialogDescription>
                    The connector at this address can be added, and Bots can use
                    its tools.
                  </DialogDescription>
                </DialogHeader>
                <DialogBody className="mt-4">
                  <Input
                    aria-label="Connector address"
                    autoComplete="off"
                    onChange={(event) => setAddress(event.target.value)}
                    placeholder="https://mcp.example.com/mcp"
                    spellCheck={false}
                    type="url"
                    value={address}
                  />
                </DialogBody>
                <DialogFooter className="mt-4">
                  <Button
                    onClick={() => setApproving(false)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={saving || candidate === null}
                    onClick={() => {
                      if (!candidate) return;
                      setSetting("mcpAllowlist", {
                        ...mcpAllowlist,
                        servers: mcpAllowlist.servers.some(
                          (entry) => listedAddress(entry) === candidate,
                        )
                          ? mcpAllowlist.servers
                          : [...mcpAllowlist.servers, candidate],
                      });
                      setApproving(false);
                      setAddress("");
                    }}
                    size="sm"
                    type="button"
                  >
                    Approve
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        );
      }}
    </ControlsSection>
  );
}
