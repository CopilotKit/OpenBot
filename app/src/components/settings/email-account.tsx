import { IconMail } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { client } from "@/lib/client";
import { queryClient } from "@/query-client";

export type MailAccount = {
  address: string;
  username: string;
  imapHost: string;
  smtpHost: string;
  updatedAt: string;
};

const KEY = ["mail-account"] as const;

export const mailAccountQueryOptions = () => ({
  queryKey: KEY,
  queryFn: () =>
    client<MailAccount | null>("/api/mail/account", "account", {
      fallback: "Couldn't load your email settings.",
    }),
});

/**
 * Your own mailbox, for the Email tools a Bot can be given. The address and an app password, nothing
 * else for the common providers; the server checks the login before keeping it and never shows the
 * password again. Reading mail is a read; sending is a write, so it asks first like any other.
 */
export function EmailAccount() {
  const account = useQuery(mailAccountQueryOptions());
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [more, setMore] = useState(false);
  const [imapHost, setImapHost] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      client<MailAccount>("/api/mail/account", "account", {
        method: "PUT",
        body: { address, password, imapHost, smtpHost },
        fallback: "Couldn't save that mailbox.",
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(KEY, saved);
      setPassword("");
      setProblem(null);
    },
    onError: (error: Error) => setProblem(error.message),
  });
  const remove = useMutation({
    mutationFn: () =>
      client("/api/mail/account", {
        method: "DELETE",
        fallback: "Couldn't remove that mailbox.",
      }),
    onSuccess: () => queryClient.setQueryData(KEY, null),
    onError: (error: Error) => setProblem(error.message),
  });

  const saved = account.data;

  return (
    <PageSection
      description="Lets a Bot you give Email to read, search and send your mail. Reading never marks anything as read, and sending asks you first."
      title="Email"
    >
      <PageRows>
        {saved ? (
          <Item size="sm">
            <ItemMedia>
              <IconMail />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{saved.address}</ItemTitle>
              <ItemDescription>
                Connected through {saved.imapHost}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
                size="sm"
                variant="outline"
              >
                Remove
              </Button>
            </ItemActions>
          </Item>
        ) : (
          <form
            className="flex flex-col gap-3 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <Input
              aria-label="Email address"
              autoComplete="email"
              onChange={(event) => setAddress(event.target.value)}
              placeholder="you@gmail.com"
              type="email"
              value={address}
            />
            <Input
              aria-label="App password"
              autoComplete="off"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="App password"
              type="password"
              value={password}
            />
            <p className="text-muted-foreground text-xs">
              Use an app password, not your normal one. For Gmail, turn on
              2-Step Verification, then make one at
              myaccount.google.com/apppasswords.
            </p>
            {more ? (
              <>
                <Input
                  aria-label="Incoming mail server"
                  onChange={(event) => setImapHost(event.target.value)}
                  placeholder="Incoming server (IMAP), e.g. imap.example.com"
                  value={imapHost}
                />
                <Input
                  aria-label="Outgoing mail server"
                  onChange={(event) => setSmtpHost(event.target.value)}
                  placeholder="Outgoing server (SMTP), e.g. smtp.example.com"
                  value={smtpHost}
                />
              </>
            ) : (
              <button
                className="self-start text-muted-foreground text-xs underline underline-offset-4"
                onClick={() => setMore(true)}
                type="button"
              >
                Use different mail servers
              </button>
            )}
            {problem ? (
              <p className="text-destructive text-sm" role="alert">
                {problem}
              </p>
            ) : null}
            <Button
              className="self-end"
              disabled={!address.trim() || !password || save.isPending}
              type="submit"
            >
              {save.isPending ? "Checking…" : "Connect"}
            </Button>
          </form>
        )}
      </PageRows>
    </PageSection>
  );
}
