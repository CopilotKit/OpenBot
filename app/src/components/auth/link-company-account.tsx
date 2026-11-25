import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { CompanySignInProvidersItem } from "@/lib/api/generated/model";
import { linkCompanyAccount } from "@/lib/auth/client";
import { type Failure, failureOf, failureSaid } from "@/lib/load-failure";
import { cn } from "@/lib/utils";

export const LINK_COMPANY_ACCOUNT = "Link your company account";

/**
 * Link the person's company account, through one of their organization's identity providers: the browser goes to the
 * company's sign-in and comes back here signed in with both. One provider is one button. Several, a company mid-merger
 * say, are a button each, by the email domain each signs in, since an id means nothing to the person.
 *
 * `size` is the page's (`lg`, on the page that holds them out) or a row's (`sm`, in Settings).
 */
export function LinkCompanyAccount({
  providers,
  size,
  className,
}: {
  providers: CompanySignInProvidersItem[];
  size: "sm" | "lg";
  className?: string;
}) {
  const [linking, setLinking] = useState<string | null>(null);
  const [problem, setProblem] = useState<Failure | null>(null);
  if (providers.length === 0) return null;

  const link = async (providerId: string) => {
    setProblem(null);
    setLinking(providerId);
    try {
      // The browser leaves for the company's sign-in once it is started; it only stays here when it couldn't be.
      await linkCompanyAccount(providerId);
    } catch (error) {
      setProblem(
        failureOf(error, "Couldn't start signing in with your company."),
      );
      setLinking(null);
    }
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {providers.map((provider) => (
        <Button
          className={size === "lg" ? "h-10 w-full tracking-tight" : undefined}
          disabled={linking !== null}
          key={provider.id}
          onClick={() => void link(provider.id)}
          size={size}
        >
          {linking === provider.id
            ? "Opening your company's sign-in…"
            : providers.length === 1
              ? LINK_COMPANY_ACCOUNT
              : `Link through ${provider.domain}`}
        </Button>
      ))}
      {problem ? (
        <p className="text-destructive text-sm" role="alert">
          {failureSaid(problem)}
        </p>
      ) : null}
    </div>
  );
}
