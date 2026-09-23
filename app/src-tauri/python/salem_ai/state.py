"""Execution state, budgets and the per-run context every agent shares.

`RunContext` is the thing that makes a run observable and bounded: it carries
the cancellation flag, the wall-clock deadline, the token / tool-call /
sub-agent budgets, and the channel the UI reads its progress from. Agents and
tools take one; nothing in the runtime runs without it.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

from .rpc import Cancelled, Host

# The states the UI is allowed to show. They describe *what the runtime is
# doing*, never what the model is thinking: private reasoning stays private.
PLANNING = "planning"
EXECUTING = "executing"
WAITING_TOOL = "waiting_tool"
WAITING_SUBAGENT = "waiting_subagent"
RUNNING_PYTHON = "running_python"
RETRIEVING = "retrieving"
VALIDATING = "validating"
RETRYING = "retrying"
COMPLETED = "completed"
FAILED = "failed"
CANCELLED = "cancelled"

STATES = {
    PLANNING, EXECUTING, WAITING_TOOL, WAITING_SUBAGENT, RUNNING_PYTHON,
    RETRIEVING, VALIDATING, RETRYING, COMPLETED, FAILED, CANCELLED,
}


@dataclass
class Budget:
    """Hard limits on one run. Exhausting one ends the run with a real,
    observable failure rather than letting it spin."""

    seconds: float = 300.0
    steps: int = 12
    tool_calls: int = 40
    python_calls: int = 8
    subagents: int = 6
    subagent_depth: int = 2
    tokens: int = 400_000

    def scaled(self, factor: float) -> "Budget":
        return Budget(
            seconds=self.seconds * factor,
            steps=max(1, int(self.steps * factor)),
            tool_calls=max(1, int(self.tool_calls * factor)),
            python_calls=max(1, int(self.python_calls * factor)),
            subagents=self.subagents,
            subagent_depth=self.subagent_depth,
            tokens=int(self.tokens * factor),
        )


@dataclass
class Spend:
    steps: int = 0
    tool_calls: int = 0
    python_calls: int = 0
    subagents: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    tool_failures: int = 0
    retries: int = 0
    python_failures: int = 0
    retrieval_failures: int = 0

    def as_dict(self) -> dict:
        return dict(self.__dict__)


class BudgetError(RuntimeError):
    """A budget ran out. The run stops and says which one."""


@dataclass
class RunContext:
    """Everything one run needs to be observed, bounded and stopped."""

    run_id: str
    host: Host
    budget: Budget = field(default_factory=Budget)
    spend: Spend = field(default_factory=Spend)
    depth: int = 0
    feature: str = "chat"
    started: float = field(default_factory=time.monotonic)
    _cancel: threading.Event = field(default_factory=threading.Event)
    _state: str = EXECUTING

    # ------------------------------------------------------------ lifecycle

    def cancel(self) -> None:
        self._cancel.set()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def check(self) -> None:
        """Called at every step boundary and before every tool call."""
        if self._cancel.is_set():
            raise Cancelled("stopped")
        if self.elapsed > self.budget.seconds:
            raise BudgetError(f"this took longer than the {self.budget.seconds:.0f}s limit")
        if self.spend.input_tokens + self.spend.output_tokens > self.budget.tokens:
            raise BudgetError("this used more tokens than the limit for one task")

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.started

    @property
    def remaining(self) -> float:
        return max(0.0, self.budget.seconds - self.elapsed)

    def call(self, method: str, args: dict, timeout: float | None = None) -> Any:
        """A host call bound to this run: it gives up the moment the run is
        cancelled, instead of holding a worker thread on a slow tool."""
        return self.host.call(method, args, timeout=timeout, abort=self._cancel)

    # --------------------------------------------------------------- output

    def state(self, state: str, detail: str = "") -> None:
        if state not in STATES:
            raise ValueError(f"unknown execution state {state!r}")
        self._state = state
        self.emit({"kind": "state", "state": state, "detail": detail})

    @property
    def current_state(self) -> str:
        return self._state

    def emit(self, event: dict) -> None:
        self.host.event(self.run_id, event)

    def text(self, chunk: str) -> None:
        if chunk:
            self.emit({"kind": "text", "text": chunk})

    def note(self, message: str) -> None:
        """A short, user-safe line about what is happening."""
        self.emit({"kind": "note", "text": message})

    # ------------------------------------------------------------ telemetry

    def charge_tokens(self, input_tokens: int, output_tokens: int) -> None:
        self.spend.input_tokens += max(0, input_tokens)
        self.spend.output_tokens += max(0, output_tokens)

    def telemetry(self, **extra: Any) -> dict:
        return {
            "run": self.run_id,
            "feature": self.feature,
            "durationMs": int(self.elapsed * 1000),
            "state": self._state,
            **self.spend.as_dict(),
            **extra,
        }

    # -------------------------------------------------------------- budgets

    def spend_tool(self) -> None:
        self.check()
        self.spend.tool_calls += 1
        if self.spend.tool_calls > self.budget.tool_calls:
            raise BudgetError("this task made too many tool calls")

    def spend_python(self) -> None:
        self.spend.python_calls += 1
        if self.spend.python_calls > self.budget.python_calls:
            raise BudgetError("this task ran Python too many times")

    def spend_subagent(self) -> None:
        if self.depth >= self.budget.subagent_depth:
            raise BudgetError("sub-agents cannot delegate this deep")
        self.spend.subagents += 1
        if self.spend.subagents > self.budget.subagents:
            raise BudgetError("this task used too many sub-agents")

    def child(self, depth_delta: int = 1) -> "RunContext":
        """A context for a sub-agent: same budgets and the same stop switch,
        one level deeper, with the time already spent counted against it."""
        kid = RunContext(
            run_id=self.run_id,
            host=self.host,
            budget=self.budget,
            spend=self.spend,
            depth=self.depth + depth_delta,
            feature=self.feature,
            started=self.started,
        )
        kid._cancel = self._cancel
        return kid
