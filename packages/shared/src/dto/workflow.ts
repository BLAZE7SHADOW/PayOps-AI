/**
 * Operator workflow DTOs (P2 task 2, D068): case notes, saved views, shift handoff.
 * Kept apart from api.ts so the queue filters and the handoff text stay easy to find.
 */
import { z } from 'zod';
import { CASE_STATUS, CASE_TYPES, SEVERITIES, type ActorType, type CaseStatus, type CaseType, type Severity } from '../enums';

// ── Case notes (written by operators, not the customer support notes on a payment) ──
export const OperatorNoteBody = z.object({ text: z.string().trim().min(1, 'Write a note first.').max(2000) }).strict();
export type OperatorNoteBody = z.infer<typeof OperatorNoteBody>;

export interface OperatorNoteItem {
  id: string;
  caseId: string;
  text: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

// ── Saved views: a named set of queue filters, private to one user ───────────────────
export const SavedViewFilters = z
  .object({
    status: z.enum(CASE_STATUS).optional(),
    type: z.enum(CASE_TYPES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    scope: z.enum(['open', 'closed', 'all']).optional(),
    /** A user id, `unassigned`, or `me` (resolved to the viewer when the view is applied). */
    assigneeId: z.string().min(1).max(64).optional(),
    overdue: z.boolean().optional(),
    q: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type SavedViewFilters = z.infer<typeof SavedViewFilters>;

export const MAX_SAVED_VIEWS_PER_USER = 20;

export const SavedViewBody = z
  .object({ name: z.string().trim().min(1, 'Name the view.').max(60), filters: SavedViewFilters })
  .strict();
export type SavedViewBody = z.infer<typeof SavedViewBody>;

export interface SavedViewItem {
  id: string;
  name: string;
  filters: SavedViewFilters;
  createdAt: string;
}

// ── Shift handoff summary (computed in code, no model involved) ─────────────────────
export const HandoffQuery = z.object({
  hours: z.coerce.number().int().min(1).max(72).default(8),
});
export type HandoffQuery = z.infer<typeof HandoffQuery>;

export interface HandoffCaseRef {
  id: string;
  displayId: string;
  type: CaseType;
  severity: Severity;
  status: CaseStatus;
  amountMinor: number;
  dueAt: string | null;
  overdue: boolean;
  assigneeName: string | null;
  /** Why it is on the list, in code-written phrases: "Overdue", "Waiting for approval", "Critical". */
  reasons: string[];
  /** Newest operator note, if any. */
  lastNote: { text: string; authorName: string; at: string } | null;
}

export interface HandoffSummary {
  generatedAt: string;
  sinceHours: number;
  since: string;
  open: {
    total: number;
    overdue: number;
    awaitingApproval: number;
    unassigned: number;
    bySeverity: Record<Severity, number>;
  };
  /** Open cases an incoming operator should look at first, most urgent first (max 10). */
  needsAttention: HandoffCaseRef[];
  resolved: { total: number; by: Record<ActorType, number> };
  recentNotes: Array<{ caseId: string; displayId: string; text: string; authorName: string; at: string }>;
}
