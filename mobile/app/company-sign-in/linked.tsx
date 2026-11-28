import { router } from "expo-router";
import { useEffect } from "react";
import { backToHome, reportCompanyLinked } from "../../src/link-company";

/**
 * openbotmobile://company-sign-in/linked: OpenBot's page once the person's company account is linked, opening the app
 * (../../src/link-company.ts). Home reads the company sign-in again, and leaves the held state once it is met; this
 * screen is only the way back to it, and leaves no second Home behind (`backToHome`).
 */
export default function CompanySignInLinked() {
  useEffect(() => {
    reportCompanyLinked();
    backToHome(router);
  }, []);
  return null;
}
