"""Working memory: the compact task state that outlives the conversation.

A long chat is a bad place to keep what a task actually depends on — the due
date the student mentioned forty messages ago, the four assignments already
imported, the one page that still failed to parse. This module keeps that as a
small structured record, saved on the app side under a task id, so a run can:

  * pick up where an interrupted one stopped;
  * compact the raw history without losing the objective, the constraints or
    what has already been done;
  * tell the student what is still outstanding instead of rediscovering it.

The objective is written once, when the task starts, and compaction can only
*append* to it. A summariser is never allowed to quietly restate what the
student asked for.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field, asdict
from typing import Any

from .rpc import HostError
from .state import RunContext

# Roughly four characters per token; the threshold is deliberately generous, so
# compaction is rare and recent turns always survive it.
CHARS_PER_TOKEN = 4
COMPACT_ABOVE_TOKENS = 24_000
KEEP_RECENT_TURNS = 8


@dataclass
class WorkingMemory:
    task_id: str = ""
    objective: str = ""
    constraints: list[str] = field(default_factory=list)
    dates: dict[str, str] = field(default_factory=dict)
    numbers: dict[str, str] = field(default_factory=dict)
    entities: list[str] = field(default_factory=list)
    done: list[str] = field(default_factory=list)
    pending: list[str] = field(default_factory=list)
    tool_results: list[str] = field(default_factory=list)
    decisions: list[str] = field(default_factory=list)
    validations: list[str] = field(default_factory=list)
    expected_final_state: str = ""
    summary: str = ""
    unresolved: list[str] = field(default_factory=list)
    updated_at: float = 0.0

    # ------------------------------------------------------------- mutation

    def start(self, objective: str) -> None:
        """Set the objective the first time only. Later runs of the same task
        add to it; nothing overwrites it."""
        text = objective.strip()
        if not text:
            return
        if not self.objective:
            self.objective = text
        elif text not in self.objective:
            self.objective = f"{self.objective}\n\nThen the student added: {text}"

    def record(self, bucket: str, item: str, limit: int = 40) -> None:
        text = item.strip()
        if not text:
            return
        values: list[str] = getattr(self, bucket)
        if text in values:
            return
        values.append(text)
        del values[:-limit]

    def complete(self, item: str) -> None:
        self.record("done", item)
        self.pending = [p for p in self.pending if p != item.strip()]

    def merge(self, patch: dict) -> None:
        """Fold in a model-written update. The objective is read-only here."""
        for key in ("constraints", "entities", "done", "pending", "tool_results",
                    "decisions", "validations", "unresolved"):
            for item in patch.get(key) or []:
                self.record(key, str(item))
        for key in ("dates", "numbers"):
            mapping: dict[str, str] = getattr(self, key)
            for name, value in (patch.get(key) or {}).items():
                mapping[str(name)] = str(value)
        if patch.get("expectedFinalState"):
            self.expected_final_state = str(patch["expectedFinalState"])
        if patch.get("summary"):
            self.summary = str(patch["summary"])

    # ------------------------------------------------------------- rendering

    def is_empty(self) -> bool:
        return not any([self.objective, self.constraints, self.done, self.pending,
                        self.dates, self.numbers, self.entities, self.summary])

    def as_prompt(self) -> str:
        """What the agent is shown. Short, ordered by what it needs first."""
        if self.is_empty():
            return ""
        lines = ["## Task state (carried over — trust this over your memory of the conversation)"]
        if self.objective:
            lines.append(f"Objective: {self.objective}")
        if self.expected_final_state:
            lines.append(f"Expected final state: {self.expected_final_state}")
        blocks = [
            ("Constraints", self.constraints), ("Entities", self.entities),
            ("Already done", self.done), ("Still to do", self.pending),
            ("Decisions", self.decisions), ("Validated", self.validations),
            ("Unresolved — ask rather than guess", self.unresolved),
            ("Earlier tool results", self.tool_results[-8:]),
        ]
        for title, values in blocks:
            if values:
                lines.append(f"{title}:")
                lines.extend(f"- {v}" for v in values)
        for title, mapping in (("Dates", self.dates), ("Numbers", self.numbers)):
            if mapping:
                lines.append(f"{title}: " + "; ".join(f"{k} = {v}" for k, v in mapping.items()))
        if self.summary:
            lines.append(f"Earlier in this conversation:\n{self.summary}")
        return "\n".join(lines)

    def as_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_dict(raw: dict | None) -> "WorkingMemory":
        if not isinstance(raw, dict):
            return WorkingMemory()
        known = {f for f in WorkingMemory().__dict__}
        return WorkingMemory(**{k: v for k, v in raw.items() if k in known})


# ---------------------------------------------------------------- persistence


def load(ctx: RunContext, task_id: str) -> WorkingMemory:
    if not task_id:
        return WorkingMemory()
    try:
        raw = ctx.call("task.load", {"taskId": task_id}, timeout=20)
    except HostError:
        return WorkingMemory(task_id=task_id)
    memory = WorkingMemory.from_dict(raw)
    memory.task_id = task_id
    return memory


def save(ctx: RunContext, memory: WorkingMemory) -> None:
    if not memory.task_id:
        return
    memory.updated_at = time.time()
    try:
        ctx.call("task.save", {"taskId": memory.task_id, "state": memory.as_dict()}, timeout=20)
    except HostError as exc:
        ctx.host.log("warn", f"could not save task state: {exc}")
    ctx.emit({"kind": "memory", "state": memory.as_dict()})


# ---------------------------------------------------------------- compaction


def too_large(messages: list[dict]) -> bool:
    return _size(messages) > COMPACT_ABOVE_TOKENS * CHARS_PER_TOKEN


def _size(messages: list[dict]) -> int:
    total = 0
    for m in messages:
        content = m.get("content")
        total += len(content) if isinstance(content, str) else len(json.dumps(content, default=str))
    return total


COMPACT_PROMPT = """You are compacting a long study conversation into structured task state.

Return ONLY a JSON object with these keys (omit what does not apply):
{"summary": "what happened earlier, in a few sentences",
 "constraints": ["requirements the student set"],
 "entities": ["courses, notebooks, files, people that matter"],
 "dates": {"what it is": "YYYY-MM-DD or the exact words used"},
 "numbers": {"what it is": "the value with its unit"},
 "decisions": ["choices already made and why"],
 "done": ["actions already carried out"],
 "pending": ["actions asked for and not yet carried out"],
 "unresolved": ["anything ambiguous that must be asked about rather than guessed"]}

Rules: keep the student's own wording for dates, names and figures. Never
invent a value to fill a field. Never restate or reinterpret what the student
asked for — the objective is recorded separately and must not be changed."""


def compact(ctx: RunContext, model, memory: WorkingMemory, messages: list[dict]) -> list[dict]:
    """Fold everything but the recent turns into working memory.

    Returns the messages to actually send. If the summariser fails the history
    is simply truncated — the task state already holds what matters, and losing
    old chat is better than sending a request that cannot succeed.
    """
    if len(messages) <= KEEP_RECENT_TURNS + 1 or not too_large(messages):
        return messages
    head = [m for m in messages if m.get("role") == "system"]
    body = [m for m in messages if m.get("role") != "system"]
    older, recent = body[:-KEEP_RECENT_TURNS], body[-KEEP_RECENT_TURNS:]
    if not older:
        return messages

    ctx.note("Summarising the earlier part of this conversation")
    transcript = "\n\n".join(f"{m.get('role')}: {_plain(m.get('content'))[:2000]}" for m in older)[-120_000:]
    try:
        reply = model.stream(
            [{"role": "system", "content": [{"type": "text", "text": COMPACT_PROMPT}]},
             {"role": "user", "content": [{"type": "text", "text": transcript}]}],
            stream_to_ui=False,
        )
        patch = _json_object(reply.content or "")
        if patch:
            memory.merge(patch)
            save(ctx, memory)
    except Exception as exc:  # compaction must never fail the run
        ctx.host.log("warn", f"compaction failed, truncating instead: {exc}")

    carried = memory.as_prompt()
    bridge = [{"role": "user", "content": f"[Earlier messages were compacted.]\n{carried}"}] if carried else []
    return head + bridge + recent


def _plain(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return "" if content is None else json.dumps(content, default=str)


def _json_object(text: str) -> dict | None:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        value = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None
