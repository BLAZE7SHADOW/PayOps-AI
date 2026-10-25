/**
 * Graph nodes (docs/03-agent-system.md §5), one file per responsibility. `buildNodes` returns them
 * keyed by node name, ready for `graph.ts`.
 */
import type { AgentDeps } from '../deps';
import { buildCloseNodes } from './close';
import { buildControlNodes } from './control';
import { buildGroundingNode } from './grounding';
import { buildIntakeNodes } from './intake';
import { buildResolveNode } from './resolve';
import { createBudgetGuard, type NodeContext } from './shared';
import { buildSpecialistNodes } from './specialists';

export { toAttemptHistory } from './shared';

export function buildNodes(deps: AgentDeps) {
  const ctx: NodeContext = { ...deps, guardBudget: createBudgetGuard(deps.onEvent) };
  return {
    ...buildIntakeNodes(ctx),
    ...buildSpecialistNodes(ctx),
    ...buildGroundingNode(ctx),
    ...buildResolveNode(ctx),
    ...buildControlNodes(ctx),
    ...buildCloseNodes(ctx),
  };
}
