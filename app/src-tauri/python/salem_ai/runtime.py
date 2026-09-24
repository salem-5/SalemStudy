from __future__ import annotations

import json
import re
import time
from typing import Any

from . import workmem
from .agents import AGENTS, build
from .model import HostModel
from .rpc import Cancelled, Host, HostError
from .state import (
    Budget, BudgetError, CANCELLED, COMPLETED, EXECUTING, FAILED, PLANNING,
    RETRYING, RunContext, VALIDATING,
)
from .toolkit import Registry, ToolFailed

_MAX_ATTEMPTS = 3


class Runtime:
    def __init__(self, host: Host) -> None:
        self.host = host
        self.runs: dict[str, RunContext] = {}

    def cancel(self, run_id: str) -> None:
        ctx = self.runs.get(run_id)
        if ctx is not None:
            ctx.cancel()

    def start(self, message: dict) -> None:
        run_id = str(message.get("run") or "")
        payload = message.get("input") or {}
        ctx = RunContext(
            run_id=run_id,
            host=self.host,
            budget=_budget(payload.get("budget"), payload.get("agent") or "chat"),
            feature=str(payload.get("feature") or payload.get("agent") or "chat"),
        )
        self.runs[run_id] = ctx
        try:
            result = self._run(ctx, payload)
            self.host.done(run_id, True, result)
        except Cancelled:
            ctx.state(CANCELLED, "Stopped")
            self.host.done(run_id, False, {"state": CANCELLED, "telemetry": ctx.telemetry()}, "stopped")
        except BudgetError as exc:
            ctx.state(FAILED, str(exc))
            self.host.done(run_id, False, {"state": FAILED, "telemetry": ctx.telemetry()}, str(exc))
        except Exception as exc:
            ctx.state(FAILED, _readable(exc))
            self.host.done(run_id, False, {"state": FAILED, "telemetry": ctx.telemetry()}, _readable(exc))
        finally:
            self.runs.pop(run_id, None)
            try:
                self.host.call("telemetry.record", ctx.telemetry(), timeout=10)
            except HostError:
                pass

    def _run(self, ctx: RunContext, payload: dict) -> dict:
        kind = str(payload.get("agent") or "chat")
        if kind not in AGENTS:
            raise ValueError(f"unknown agent {kind!r}")
        registry = Registry(payload.get("tools") or [])
        model_id = str(payload.get("model") or "")
        if not model_id:
            raise ValueError("no model was given for this run")

        memory = workmem.load(ctx, str(payload.get("taskId") or ""))
        objective = str(payload.get("objective") or _last_user(payload.get("messages") or []))
        memory.start(objective)

        model = HostModel(ctx, model_id, thinking=bool(payload.get("thinking")))
        messages = _messages(payload, memory)
        messages = workmem.compact(ctx, model, memory, messages)

        mode = str(payload.get("mode") or "auto")
        schema = payload.get("schema")
        if mode == "direct":
            direct = self._direct(ctx, model, registry, messages, payload, schema)
            if direct is not None:
                return self._finish(ctx, memory, direct)
            ctx.note("This needs a proper look - switching to the agent")

        result = self._agentic(ctx, registry, model_id, payload, memory, messages, schema)
        return self._finish(ctx, memory, result)

    def _direct(self, ctx: RunContext, model: HostModel, registry: Registry,
                messages: list[dict], payload: dict, schema: Any = None) -> dict | None:
        ctx.state(EXECUTING, "Answering")
        tools = registry.select(
            ctx,
            allow=payload.get("allow"),
            scopes=AGENTS[str(payload.get("agent") or "chat")].scopes,
            read_only=AGENTS[str(payload.get("agent") or "chat")].read_only,
        )
        ask = (messages + [{"role": "user", "content": _parts(_schema_ask(schema))}]) if schema else messages
        reply = model.stream(
            ask, tools=tools or None,
            stream_to_ui=not schema,
            response_format={"type": "json_object"} if schema else None,
        )
        if reply.tool_calls:
            return None
        text = (reply.content or "").strip()
        if not text:
            return None
        if schema:
            ctx.state(VALIDATING, "Checking the result against the schema")
            value, problem = _validate(text, schema)
            if problem:
                ctx.note("The first pass did not fit - working through it properly")
                return None
            return {"text": "", "structured": value, "state": COMPLETED, "path": "direct"}
        return {"text": text, "state": COMPLETED, "path": "direct"}

    def _agentic(self, ctx: RunContext, registry: Registry, model_id: str, payload: dict,
                 memory: workmem.WorkingMemory, messages: list[dict],
                 schema: Any) -> dict:
        kind = str(payload.get("agent") or "chat")
        ctx.state(PLANNING, "Working out how to do this")
        task = _task_text(messages, memory, payload)
        last_error = ""

        for attempt in range(1, _MAX_ATTEMPTS + 1):
            ctx.check()
            if attempt > 1:
                ctx.spend.retries += 1
                ctx.state(RETRYING, f"Attempt {attempt} after: {last_error[:120]}")
            agent = build(
                kind, ctx, registry, model_id,
                thinking=bool(payload.get("thinking")),
                extra_instructions=_schema_note(schema) + _retry_note(last_error),
                files=[int(f) for f in (payload.get("files") or [])],
                sources=[int(s) for s in (payload.get("sources") or [])],
                allow=payload.get("allow"),
                python_timeout=float(payload.get("pythonTimeout") or 60.0),
                subagents=payload.get("subagents"),
            )
            try:
                run = agent.run(task, return_full_result=True)
            except Cancelled:
                raise
            except (ToolFailed, HostError) as exc:
                last_error = _readable(exc)
                if attempt == _MAX_ATTEMPTS or ctx.remaining < 20:
                    raise
                continue
            except Exception as exc:
                last_error = _readable(exc)
                if attempt == _MAX_ATTEMPTS or ctx.remaining < 20:
                    return self._fallback(ctx, model_id, messages, last_error)
                continue

            output = run.output
            text = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False, default=str)
            stalled = run.state == "max_steps_error"
            if stalled and not text.strip():
                last_error = "the agent ran out of steps without an answer"
                if attempt < _MAX_ATTEMPTS:
                    continue

            if schema:
                ctx.state(VALIDATING, "Checking the result against the schema")
                value, problem = _validate(output, schema)
                if problem:
                    last_error = problem
                    if attempt < _MAX_ATTEMPTS:
                        continue
                    raise ValueError(f"the generated data did not match the schema: {problem}")
                return {"text": "", "structured": value, "state": COMPLETED, "path": "agentic",
                        "steps": len(run.steps or []), **_stalled(stalled)}

            return {"text": str(text), "state": COMPLETED, "path": "agentic",
                    "steps": len(run.steps or []), **_stalled(stalled)}

        raise RuntimeError(last_error or "the task could not be completed")

    def _fallback(self, ctx: RunContext, model_id: str, messages: list[dict], why: str) -> dict:
        ctx.note("Tools kept failing - answering without them")
        model = HostModel(ctx, model_id)
        reply = model.stream(messages + [{"role": "user", "content": _parts(
            "Your tools are not working in this run: " + why +
            ". Answer from what you already know, and say clearly at the end "
            "which part you could not check or carry out.")}])
        return {"text": (reply.content or "").strip(), "state": COMPLETED, "path": "fallback",
                "degraded": True, "reason": why}

    def _finish(self, ctx: RunContext, memory: workmem.WorkingMemory, result: dict) -> dict:
        if memory.task_id:
            workmem.save(ctx, memory)
        ctx.state(COMPLETED, "Done")
        return {**result, "memory": memory.as_dict(), "telemetry": ctx.telemetry()}



def _budget(raw: Any, kind: str) -> Budget:
    base = Budget()
    if kind == "task":
        base = base.scaled(3.0)
    elif kind == "generation":
        base = base.scaled(2.0)
    elif kind == "notebook":
        base = base.scaled(1.5)
    if isinstance(raw, dict):
        for key in ("seconds", "steps", "toolCalls", "pythonCalls", "subagents", "subagentDepth", "tokens"):
            if raw.get(key) is None:
                continue
            attr = re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower()
            setattr(base, attr, type(getattr(base, attr))(raw[key]))
    return base


def _messages(payload: dict, memory: workmem.WorkingMemory) -> list[dict]:
    system = "\n\n".join(x for x in (str(payload.get("system") or "").strip(), memory.as_prompt()) if x)
    out: list[dict] = [{"role": "system", "content": _parts(system)}] if system else []
    for message in payload.get("messages") or []:
        role = str(message.get("role") or "user")
        if role not in ("system", "user", "assistant"):
            continue
        parts = _parts(message.get("content"))
        if not parts:
            continue
        if out and out[-1]["role"] == role:
            out[-1]["content"].extend(parts)
        else:
            out.append({"role": role, "content": parts})
    return out


def _parts(content: Any) -> list[dict]:
    if content is None:
        return []
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content.strip() else []
    if isinstance(content, list):
        out = []
        for part in content:
            if isinstance(part, dict) and part.get("type"):
                out.append(part)
            elif isinstance(part, str) and part.strip():
                out.append({"type": "text", "text": part})
        return out
    return [{"type": "text", "text": json.dumps(content, default=str)}]


def _last_user(messages: list[dict]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            return _plain(message.get("content"))
    return ""


def _plain(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return "" if content is None else json.dumps(content, default=str)


def _task_text(messages: list[dict], memory: workmem.WorkingMemory, payload: dict) -> str:
    parts: list[str] = []
    carried = memory.as_prompt()
    if carried:
        parts.append(carried)
    body = [m for m in messages if m.get("role") != "system"]
    if len(body) > 1:
        transcript = "\n\n".join(f"{m['role']}: {_plain(m['content'])[:4000]}" for m in body[:-1])
        parts.append(f"## The conversation so far\n{transcript[-40_000:]}")
    last = body[-1] if body else {"content": ""}
    parts.append("## What to do now\n" + _plain(last.get("content")))
    return "\n\n".join(parts)


def _schema_note(schema: Any) -> str:
    if not schema:
        return ""
    return ("\n\nWhen you are finished, call final_answer with a JSON object matching this schema "
            "exactly, and nothing else:\n" + json.dumps(schema, ensure_ascii=False)[:6000])


def _schema_ask(schema: Any) -> str:
    return ("Answer with a single JSON object matching this schema exactly, and nothing else "
            "- no prose, no code fence:\n" + json.dumps(schema, ensure_ascii=False)[:6000])


def _retry_note(error: str) -> str:
    if not error:
        return ""
    return f"\n\nA previous attempt failed with: {error[:500]}\nTake a different route this time."


def _validate(output: Any, schema: Any) -> tuple[Any, str]:
    value = output
    if isinstance(value, str):
        text = value.strip()
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            start, end = text.find("["), text.rfind("]")
        if start < 0 or end <= start:
            return None, "the answer was not JSON"
        try:
            value = json.loads(text[start:end + 1])
        except json.JSONDecodeError as exc:
            return None, f"the answer was not valid JSON ({exc.msg} at character {exc.pos})"
    problem = _check(value, schema, "")
    return (None, problem) if problem else (value, "")


def _check(value: Any, schema: Any, path: str) -> str:
    if not isinstance(schema, dict):
        return ""
    where = path or "the result"
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            return f"{where} should be an object, got {type(value).__name__}"
        for key in schema.get("required") or []:
            if key not in value:
                return f"{where} is missing the required key {key!r}"
        for key, sub in (schema.get("properties") or {}).items():
            if key in value:
                problem = _check(value[key], sub, f"{path}.{key}" if path else key)
                if problem:
                    return problem
    elif kind == "array":
        if not isinstance(value, list):
            return f"{where} should be an array, got {type(value).__name__}"
        if schema.get("minItems") is not None and len(value) < int(schema["minItems"]):
            return f"{where} has {len(value)} items, fewer than the {schema['minItems']} required"
        item = schema.get("items")
        for i, entry in enumerate(value[:200]):
            problem = _check(entry, item, f"{path}[{i}]")
            if problem:
                return problem
    elif kind in ("string", "number", "integer", "boolean"):
        types = {"string": str, "number": (int, float), "integer": int, "boolean": bool}[kind]
        if not isinstance(value, types) or (kind != "boolean" and isinstance(value, bool)):
            return f"{where} should be a {kind}, got {type(value).__name__}"
        if schema.get("enum") and value not in schema["enum"]:
            return f"{where} is {value!r}, which is not one of {schema['enum']}"
    return ""


def _stalled(stalled: bool) -> dict:
    if not stalled:
        return {}
    return {"degraded": True, "reason": "ran out of steps before finishing - this answer may be incomplete"}


def _readable(exc: BaseException) -> str:
    text = str(exc).strip() or exc.__class__.__name__
    return text[:600]
