/** Turns a raw User-Agent header into "Chrome on macOS" for the session list. */
export function describeUserAgent(ua: string): string {
  if (!ua.trim()) return 'Unknown device';
  // Order matters: Edge and Opera also say Chrome, and Chrome also says Safari.
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /curl|node|supertest|axios/i.test(ua)
              ? 'Script'
              : null;
  // iPhone and Android UAs also contain "Mac OS X" or "Linux", so test them first.
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux|X11/.test(ua)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'Unknown device';
}

/** An otpauth link is shown as text so it can be pasted into an app that cannot scan a code. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}
