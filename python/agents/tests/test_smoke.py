from payops_agents import __version__


def test_package_imports() -> None:
    assert __version__ == "0.1.0"


def test_langgraph_is_available() -> None:
    from langgraph.graph import END, START, StateGraph

    assert START and END and StateGraph
