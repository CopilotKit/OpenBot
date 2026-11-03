/**
 * The mail servers of the common providers, so a person types their address and an app password
 * and nothing else. Anything not listed falls back to `imap.<domain>` and `smtp.<domain>`, which a
 * person can change.
 *
 * TLS only: 993 for IMAP, and 465 (or STARTTLS on 587, which TLS is then required on) for SMTP. A
 * password never crosses the wire in the clear.
 */
export type MailServers = {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
};

const KNOWN: Record<string, MailServers> = {
  "gmail.com": gmail(),
  "googlemail.com": gmail(),
  "outlook.com": outlook(),
  "hotmail.com": outlook(),
  "live.com": outlook(),
  "msn.com": outlook(),
  "yahoo.com": servers("imap.mail.yahoo.com", "smtp.mail.yahoo.com"),
  "icloud.com": servers("imap.mail.me.com", "smtp.mail.me.com"),
  "me.com": servers("imap.mail.me.com", "smtp.mail.me.com"),
  "aol.com": servers("imap.aol.com", "smtp.aol.com"),
  "fastmail.com": servers("imap.fastmail.com", "smtp.fastmail.com"),
  "gmx.com": servers("imap.gmx.com", "mail.gmx.com"),
  "zoho.com": servers("imap.zoho.com", "smtp.zoho.com"),
};

function servers(imapHost: string, smtpHost: string): MailServers {
  return { imapHost, imapPort: 993, smtpHost, smtpPort: 465 };
}

function gmail() {
  return servers("imap.gmail.com", "smtp.gmail.com");
}

function outlook() {
  // Microsoft's SMTP answers TLS only after STARTTLS on 587, never on 465.
  return {
    ...servers("outlook.office365.com", "smtp.office365.com"),
    smtpPort: 587,
  };
}

/** The servers for an address: a known provider's, or the usual names under its domain. */
export function serversFor(address: string): MailServers {
  const domain = address.split("@").pop()?.trim().toLowerCase() ?? "";
  const known = KNOWN[domain];
  if (known) return { ...known };
  return servers(`imap.${domain}`, `smtp.${domain}`);
}

const HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * Why a server name is refused, or null. A real public host name only: no address literals, no
 * localhost, no internal suffixes, so a saved mailbox can never be pointed at this deployment's
 * own network.
 */
export function hostRefusal(host: string): string | null {
  const value = host.trim().toLowerCase();
  if (!HOST.test(value)) return `“${host}” is not a mail server name.`;
  if (/(^|\.)(localhost|local|internal|lan|home|corp)$/.test(value)) {
    return `“${host}” is a private name, not a mail server on the internet.`;
  }
  return null;
}

export function isAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
