/** Rows the API returns; every FreeAgent resource carries a `url`. */
export interface Paged {
  /** Resource URI, used to detect a page that did not advance. */
  url?: string;
}

/**
 * Page collection with a stall guard.
 *
 * Not every FreeAgent list endpoint documents `page` and `per_page` — bills
 * do not. An endpoint that ignores them returns the same rows for every page,
 * and a loop that stops only on a short page would then never stop, fetching
 * the same batch until the process is killed. Comparing each page's first URL
 * to the previous one turns that from a hang into a clean stop.
 */
export class Paging {
  /** Fetch pages from 1 until a short page, a repeat, or the cap. */
  static async collect<T extends Paged>(
    fetchPage: (page: number) => Promise<T[]>,
    perPage: number,
    maxPages = 100,
  ): Promise<T[]> {
    const all: T[] = [];
    let previousFirst: string | undefined;
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await fetchPage(page);
      if (batch.length === 0) return all;

      const first = batch[0]?.url;
      if (page > 1 && first !== undefined && first === previousFirst) {
        // The endpoint ignored `page`. Everything it can give us is already
        // in `all` from the first pass; anything more would be duplicates.
        return all;
      }
      previousFirst = first;

      all.push(...batch);
      if (batch.length < perPage) return all;
    }
    throw new Error(
      `pagination exceeded ${maxPages} pages — refusing to keep fetching rather than return a partial set silently`,
    );
  }
}
