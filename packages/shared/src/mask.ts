/** PII masking used by API projections and agent tool DTOs. */
export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  if (!domain) return '***';
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(3, user.length - 1))}@${domain}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  return `+91 ******${last4}`;
}

// Free-text scrubber (docs/07-security.md, D078). The field maskers above only help when a value
// sits under a known key. This one looks at the text itself, so an email or phone number that a
// customer typed into a note, or that ended up inside a finding statement, is still removed before
// the text leaves for Gemini or Jev. It is a safety net, not a PII detector: it catches emails,
// Indian-style mobile numbers and long digit runs (card or account numbers). Names are not caught.
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_IN_TEXT = /(?<![\w.])(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g;
const LONG_DIGITS_IN_TEXT = /(?<![\w.])\d(?:[\s-]?\d){11,18}(?!\d)/g;

export function scrubPiiText(text: string): string {
  return text
    .replace(EMAIL_IN_TEXT, '[email removed]')
    .replace(PHONE_IN_TEXT, '[phone removed]')
    .replace(LONG_DIGITS_IN_TEXT, '[number removed]');
}
