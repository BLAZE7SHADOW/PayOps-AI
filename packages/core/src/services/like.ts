/** Escape LIKE/ILIKE wildcards in user input so a search is a literal prefix match. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
