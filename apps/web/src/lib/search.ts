/** Where the global search sends a query. Pure so it can be unit tested. */
export function searchTarget(raw: string): string | null {
  const q = raw.trim();
  if (!q) return null;
  if (/^case_[a-z0-9]+$/i.test(q)) return `/cases/${encodeURIComponent(q)}`;
  if (/^(PAY|RFD|STL|RSK|DUP)-\d{1,6}$/i.test(q)) return `/exceptions?scope=all&q=${encodeURIComponent(q.toUpperCase())}`;
  return `/payments?q=${encodeURIComponent(q)}`;
}
