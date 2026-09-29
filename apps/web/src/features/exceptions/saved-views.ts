/**
 * Maps between the Exceptions page URL and a saved view (P2 task 2, D068). Kept as plain
 * functions so the round trip is unit-tested without rendering the page.
 */
import { CASE_TYPES, SEVERITIES, type SavedViewFilters } from '@payops/shared';
import { pickEnum } from '../../lib/use-url-state';

export const VIEW_URL_KEYS = ['scope', 'type', 'severity', 'q', 'assignee', 'overdue'] as const;
export type ViewUrl = Partial<Record<(typeof VIEW_URL_KEYS)[number], string | undefined>>;

const SCOPES = ['open', 'closed', 'all'] as const;
const ASSIGNEES = ['me', 'unassigned'] as const;

/** What the operator is looking at now, as saved-view filters. Defaults are left out. */
export function filtersFromUrl(url: ViewUrl): SavedViewFilters {
  const out: SavedViewFilters = {};
  const scope = pickEnum(url.scope, SCOPES);
  if (scope && scope !== 'open') out.scope = scope;
  const type = pickEnum(url.type, CASE_TYPES);
  if (type) out.type = type;
  const severity = pickEnum(url.severity, SEVERITIES);
  if (severity) out.severity = severity;
  const q = url.q?.trim();
  if (q) out.q = q;
  const assignee = pickEnum(url.assignee, ASSIGNEES);
  if (assignee) out.assigneeId = assignee;
  if (url.overdue === 'true') out.overdue = true;
  return out;
}

/** URL patch that shows exactly this view: every key it does not set is cleared. */
export function urlPatchFromFilters(f: SavedViewFilters): Record<(typeof VIEW_URL_KEYS)[number], string | undefined> {
  const assignee = f.assigneeId === 'me' || f.assigneeId === 'unassigned' ? f.assigneeId : undefined;
  return {
    scope: f.scope && f.scope !== 'open' ? f.scope : undefined,
    type: f.type,
    severity: f.severity,
    q: f.q,
    assignee,
    overdue: f.overdue ? 'true' : undefined,
  };
}

/** Two filter sets mean the same queue (order and explicit defaults do not matter). */
export function sameFilters(a: SavedViewFilters, b: SavedViewFilters): boolean {
  return VIEW_URL_KEYS.every((k) => urlPatchFromFilters(a)[k] === urlPatchFromFilters(b)[k]);
}

export const hasFilters = (f: SavedViewFilters): boolean => Object.keys(f).length > 0;
