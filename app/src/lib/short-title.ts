/**
 * A title as a row draws it: each web address cut to its site, so "Check the page at
 * https://app.notion.com/p/team/Cycle-65-4133aa3818…" reads "Check the page at app.notion.com". A
 * routine's title is often its instruction, pasted links and all, and one address filled the row.
 * The whole title is still the row's hover text.
 */
export function shortTitle(title: string): string {
  return title.replace(/https?:\/\/[^\s<>()[\]]+/g, (address) => {
    // A sentence's own full stop or comma after the address is not part of it.
    const trailing = address.match(/[.,;:!?'"]+$/)?.[0] ?? "";
    const bare = trailing ? address.slice(0, -trailing.length) : address;
    try {
      return new URL(bare).hostname.replace(/^www\./, "") + trailing;
    } catch {
      return address;
    }
  });
}
