"""Graph nodes (docs/03 §5), one module per responsibility. `build_nodes` returns them keyed by node name."""

from __future__ import annotations

from .close import build_close_nodes
from .control import build_control_nodes
from .grounding import build_grounding_node
from .intake import build_intake_nodes
from .resolve import build_resolve_node
from .shared import AgentDeps, Node, NodeContext, create_budget_guard
from .specialists import build_specialist_nodes

__all__ = ["AgentDeps", "build_nodes"]


def build_nodes(deps: AgentDeps) -> dict[str, Node]:
    ctx = NodeContext(deps.api, deps.llm, deps.decision, deps.on_event, create_budget_guard(deps.on_event))
    return {
        **build_intake_nodes(ctx),
        **build_specialist_nodes(ctx),
        **build_grounding_node(ctx),
        **build_resolve_node(ctx),
        **build_control_nodes(ctx),
        **build_close_nodes(ctx),
    }
