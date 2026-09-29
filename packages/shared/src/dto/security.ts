/** Sign-in security: one-time codes (MFA) and the list of signed-in sessions. */
import { z } from 'zod';
import type { Role } from '../enums';
import type { SessionUser } from './api';

/** A 6-digit code as typed from an authenticator app; spaces are allowed ("123 456"). */
export const OneTimeCode = z.string().trim().min(6).max(8).regex(/^\d{3}\s?\d{3}$/, 'Enter the 6-digit code');

export const MfaLoginBody = z.object({
  /** Short-lived token returned by /auth/login when a code is required. */
  challenge: z.string().min(1).max(2000),
  code: OneTimeCode,
});
export type MfaLoginBody = z.infer<typeof MfaLoginBody>;

export const MfaCodeBody = z.object({ code: OneTimeCode });
export type MfaCodeBody = z.infer<typeof MfaCodeBody>;

/** Answer to a password check: either signed in, or a code is still needed. */
export type LoginResponse = SessionUser | { mfaRequired: true; challenge: string };

export const isMfaChallenge = (r: LoginResponse): r is { mfaRequired: true; challenge: string } =>
  'mfaRequired' in r && r.mfaRequired === true;

export interface MfaSetupResponse {
  /** Base32 seed to type into an authenticator app. Shown once, until the setup is confirmed. */
  secret: string;
  otpauthUrl: string;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string;
  userAgent: string;
  mfaVerified: boolean;
  /** The session making this request. */
  current: boolean;
}

export interface SecurityOverview {
  mfaEnabled: boolean;
  /** MANAGER and ADMIN accounts are expected to turn MFA on; the UI shows a notice until they do. */
  mfaRecommended: boolean;
  sessions: SessionInfo[];
}

export const mfaRecommendedFor = (role: Role): boolean => role === 'MANAGER' || role === 'ADMIN';
