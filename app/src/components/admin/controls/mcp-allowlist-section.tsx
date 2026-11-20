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

/** Admin, Plugins: the allowlist of MCP servers Bots may call tools on. */
export function McpAllowlistSection() {
  const [approving, setApproving] = useState(false);
  const [address, setAddress] = useState("");
  return (
    <ControlsSection
      description="With the allowlist on, Bots can only call tools on the MCP servers approved here, and people can only add a server by its address once it's approved. Calls to any other server are refused."
      title="MCP servers"
    >
      {({ data, setSetting, saving }) => {
        const { mcpAllowlist } = data.settings;
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
        return (
          <>
            <PageRows>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconPlug />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Only approved servers</ItemTitle>
                  <ItemDescription>
                    {mcpAllowlist.enabled
                      ? `${mcpAllowlist.servers.length} approved`
                      : "Off. Bots can use any registered server they have access to."}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label="Only approved MCP servers"
                    checked={mcpAllowlist.enabled}
                    disabled={saving}
                    onCheckedChange={(enabled) =>
                      setSetting("mcpAllowlist", { ...mcpAllowlist, enabled })
                    }
                  />
                </ItemActions>
              </Item>
              {data.mcpServers.map((server) => {
                const byAddress = approvedByAddress(server.url);
                return (
                  <div key={server.id}>
                    <Separator />
                    <Item size="sm">
                      <ItemMedia variant="icon">
                        <IconKey />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{server.title}</ItemTitle>
                        <ItemDescription>{server.url}</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Switch
                          aria-label={`Approve ${server.title}`}
                          checked={
                            mcpAllowlist.servers.includes(server.id) ||
                            byAddress
                          }
                          disabled={saving}
                          onCheckedChange={(checked) =>
                            setSetting("mcpAllowlist", {
                              ...mcpAllowlist,
                              servers: checked
                                ? [...mcpAllowlist.servers, server.id]
                                : mcpAllowlist.servers.filter(
                                    (entry) =>
                                      entry !== server.id &&
                                      listedAddress(entry) !==
                                        listedAddress(server.url),
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
                  <ItemTitle>Approve a server by its address</ItemTitle>
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
                  <DialogTitle>Approve a server</DialogTitle>
                  <DialogDescription>
                    People can add the MCP server at this address, and Bots can
                    call its tools.
                  </DialogDescription>
                </DialogHeader>
                <DialogBody className="mt-4">
                  <Input
                    aria-label="Server address"
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
