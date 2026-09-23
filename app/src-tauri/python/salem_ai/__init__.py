"""Salem's AI layer, built on Hugging Face smolagents.

Everything the app asks of a model goes through `Runtime`: normal chat,
thinking, notebook questions, study-material generation, background tasks and
long agentic work. The rest of the app never sees smolagents — it sends a
request over the stdio protocol in `rpc` and reads execution states back, so
this layer can be replaced without touching the app.
"""

VERSION = "1.0.0"
MIN_PYTHON = (3, 10)
# Pinned so an upgrade is a deliberate change: the agent classes, the executor
# protocol and the streaming events are all API surface we build on.
SMOLAGENTS_REQUIREMENT = "smolagents>=1.26,<2"

__all__ = ["VERSION", "MIN_PYTHON", "SMOLAGENTS_REQUIREMENT"]
