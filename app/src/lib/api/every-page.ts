/**
 * Every item of a list the API pages, read page after page until `nextCursor` is null.
 *
 * For a screen that draws a whole list. `read` asks for one page from the cursor it is given
 * (undefined for the first) and answers the page's items with the cursor of the next.
 */
export async function everyPage<T>(
  read: (cursor: string | undefined) => Promise<{
    items: T[];
    nextCursor: string | null;
  }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}
