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
