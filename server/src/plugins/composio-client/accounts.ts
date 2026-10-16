import { BrokerRefusalError, type ComposioBroker } from "../broker";
import {
  askVendor,
  sent,
  textOf,
  VENDOR_SHAPE_REMEDY,
} from "../composio-vendor";
import type { ClientContext } from "./context";
import { CONNECTED } from "./model";

/** One connected account: revoking it, and the name it is shown by. */
export function accountMethods(context: ClientContext) {
  const { vendor, accountsFor } = context;
  return {
    /**
     * ONE account ended by id, and NOT {@link ComposioBroker.revoke}, which is the whole decision.
     *
     * `revoke` ends every account a person holds for an app. That is right for what it serves — a
     * person ending their access, where any account left behind is access that still answers — and
     * it is wrong for a verification undoing what it just made. The two read identically right up
     * until the local row and Composio have drifted apart, and that is precisely the state a failed
     * verification stands in: a connection that was working, a second account just created from a
     * key that does not work, and a sweep that takes down both. So this method is handed the id and
     * nothing else — nothing is listed, nothing is matched, and no account it was not given can be
     * reached from here.
     *
     * WITH `revoke_on_delete`, FOR THE REASON {@link ComposioVendor}'s `delete` GIVES AND ONE MORE
     * OF ITS OWN. Without the flag the account stops being visible to this deployment and the
     * credential at the far end stands; here that credential is one somebody typed into a form
     * minutes ago, into a page that is about to tell them the connection was not kept.
     *
     * NOTHING IS ANSWERED AND NOTHING IS SWALLOWED. There is no count to report — the id names one
     * account that existed moments ago — so a failure is a failure, and it leaves through
     * {@link askVendor} like every other vendor call in this file.
     *
     * AND "I DID NOT DELETE IT" IS ONE OF THOSE FAILURES, WHICH THE AWAIT USED TO DISCARD. The
     * delete answers `{ success?: unknown }` for the reason {@link ComposioVendor}'s declaration
     * gives: a 200 carrying `success: false` is Composio saying it did NOT delete the account, so
     * no revocation was started and nothing was asked of the provider — the same lie
     * {@link withdrawalDeclined} exists to stop one method away. It matters MORE here than there,
     * because of what this call's caller does with a clean return. The verification step withdraws
     * the account behind a key that failed, and where the withdrawal ITSELF fails it writes the row
     * unverified so the account stays reachable and disconnectable. A `success: false` resolving
     * normally takes the other branch: no row is written, and what is left standing is a live
     * account holding a working-or-not credential that nothing on any screen names and nobody can
     * press disconnect on.
     *
     * ITS OWN SENTENCES RATHER THAN {@link withdrawalDeclined}'s, because that function's two are
     * written around a toolkit and around pressing disconnect again, and this method has neither: it
     * was handed an id, the app is the caller's to name, and the second press it would invite is a
     * button that is not on any page for an account no row points at. What carries across unchanged
     * is the null/undefined exemption — a 204 or a body of content-length zero is the vendor saying
     * it DID delete and having nothing to add, and reading those as a refusal is the same lie
     * pointing the other way.
     */
    async revokeAccount(accountId): Promise<void> {
      const answer = await askVendor(
        {
          outcome:
            "the one account this call was handed was not withdrawn and may be standing at Composio",
          /*
           * NO APP IN THE QUESTION, which is what the id being the whole of it means. The caller
           * holds the toolkit it connected and can say it; this call was given an account.
           */
          app: null,
        },
        () =>
          vendor.connectedAccounts.delete(accountId, {
            revoke_on_delete: true,
          }),
      );

      if (answer === null || answer === undefined) return;
      /*
       * AND A REPLY THAT IS NOT A DOCUMENT IS NOT A DOCUMENT WITH ITS VERDICT MISSING, which is the
       * distinction {@link withdrawalDeclined} draws one method away and for the same reason. The
       * generated client parses the body and hands it over, so a bare string or a list reaches this
       * read; `("deleted").success` is `undefined`, and the last refusal below then reported a reply
       * with one field absent about an answer that held no reply at all.
       */
      if (typeof answer !== "object" || Array.isArray(answer)) {
        throw new BrokerRefusalError(
          `Composio sent ${sent(answer)} where its reply to the withdrawal of the account this connection just made belongs, so there is no field in it saying whether the account was deleted at all. This deployment cannot tell a withdrawal that happened from one that did not, so the account is reported as still standing and the credential behind it as not withdrawn. ${VENDOR_SHAPE_REMEDY}`,
        );
      }
      const verdict = (answer as { success?: unknown }).success;
      if (verdict === true) return;
      if (verdict === false) {
        throw new BrokerRefusalError(
          `Composio answered the withdrawal of the account this connection just made with success: false, so it did not delete the account and started no revocation of the credential behind it. That account is still standing at Composio and the credential behind it is still live there.`,
        );
      }
      throw new BrokerRefusalError(
        `Composio sent ${sent(verdict)} where its verdict on the withdrawal of the account this connection just made belongs, and that field is the only thing in the reply that says whether the account was deleted at all. This deployment cannot tell a withdrawal that happened from one that did not, so the account is reported as still standing and the credential behind it as not withdrawn. ${VENDOR_SHAPE_REMEDY}`,
      );
    },

    async accountName({ account, toolkit }) {
      const rows = await accountsFor(account.vendorUserId, toolkit, CONNECTED, {
        enough: (found) => found.length > 0,
      });
      /*
       * BY NAME, AND NOTHING ELSE. `data` is the vendor's whole connection blob — access, refresh
       * and id tokens, and for some apps a client secret — and the one field a page may show is the
       * display name the vendor chose to publish. Nothing is decoded out of a token to make up for a
       * missing one: a name we had to dig for is a name the vendor did not publish.
       */
      for (const row of rows) {
        const data = row.data;
        if (data && typeof data === "object" && "displayName" in data) {
          const name = textOf((data as { displayName?: unknown }).displayName);
          if (name) return name;
        }
      }
      return null;
    },
  } satisfies Pick<ComposioBroker, "revokeAccount" | "accountName">;
}
