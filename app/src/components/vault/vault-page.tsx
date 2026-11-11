import { IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { CredentialsList } from "@/components/manage/credentials-page";
import { Button } from "@/components/ui/button";
import { useManagePaths } from "@/lib/manage-paths";
import { SavedLogins } from "./saved-logins";

/**
 * The Vault: one place for the person's saved logins and keys. It sits beside the eight things a
 * Bot has, because no Bot sees what is in it (see `docs/how-openbot-works.md`).
 *
 * Two stores behind one page. Logins are the private sign-in form's, in both editions. Keys are
 * the personal edition's own: the team edition keeps an admin's keys under Admin, and a member
 * stores none.
 */
export function VaultPage() {
  const paths = useManagePaths();
  const personal = paths.edition === "personal";
  return (
    <PageShell
      description={
        personal
          ? "Your saved logins and keys are kept here. Bots never see them."
          : "Your saved logins are kept here. Bots never see them."
      }
      title="Vault"
    >
      {/*
       * The team edition's Vault is its logins alone, one section, so it carries no heading: the
       * page title already names it.
       */}
      {personal ? (
        <PageSection
          description="Website logins you saved when signing a Bot in. You approve each use."
          title="Logins"
        >
          <SavedLogins />
        </PageSection>
      ) : (
        <PageSection>
          <SavedLogins />
        </PageSection>
      )}
      {personal ? (
        <PageSection
          action={
            // Its own screen, `vault_.new.tsx`, which says why the form is not on this page.
            <Button
              render={(props) => <Link {...props} {...paths.newCredential()} />}
              size="sm"
              variant="ghost"
            >
              <IconPlus />
              Add key
            </Button>
          }
          description="API keys and tokens your apps and models use. A saved key can't be viewed again."
          title="Keys"
        >
          <CredentialsList />
        </PageSection>
      ) : null}
    </PageShell>
  );
}
