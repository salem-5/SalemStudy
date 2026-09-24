from __future__ import annotations

import inspect
import json
import keyword
import re
from dataclasses import dataclass, field
from typing import Any

from smolagents import Tool

from .rpc import Cancelled, HostError
from .state import RunContext, WAITING_TOOL, EXECUTING, RUNNING_PYTHON, RETRIEVING

_TYPES = {"string", "boolean", "integer", "number", "image", "audio", "array", "object", "any", "null"}


class ToolFailed(RuntimeError):
    pass


@dataclass
class ToolSpec:
    name: str
    description: str
    inputs: dict[str, dict]
    output_type: str = "object"
    mutating: bool = False
    idempotent: bool = True
    scopes: list[str] = field(default_factory=list)
    label: str = ""
    timeout: float = 60.0
    state: str = WAITING_TOOL
    aliases: dict[str, str] = field(default_factory=dict)

    @staticmethod
    def parse(raw: dict) -> "ToolSpec":
        declared = {str(key): dict(value or {}) for key, value in (raw.get("inputs") or {}).items()}
        for key, value in declared.items():
            if value.get("type") not in _TYPES:
                value["type"] = "string"
            value.setdefault("description", key)
        order = sorted(declared, key=lambda k: bool(declared[k].get("nullable")))
        inputs: dict[str, dict] = {}
        aliases: dict[str, str] = {}
        for key in order:
            safe = _safe_name(key, taken=set(inputs) | (set(declared) - {key}))
            if safe != key:
                aliases[safe] = key
            inputs[safe] = declared[key]
        output = str(raw.get("outputType") or raw.get("output_type") or "object")
        return ToolSpec(
            name=str(raw["name"]),
            description=str(raw.get("description") or ""),
            inputs=inputs,
            output_type=output if output in _TYPES else "object",
            mutating=bool(raw.get("mutating")),
            idempotent=bool(raw.get("idempotent", True)),
            scopes=[str(s) for s in (raw.get("scopes") or [])],
            label=str(raw.get("label") or ""),
            timeout=float(raw.get("timeout") or 60.0),
            state=str(raw.get("state") or WAITING_TOOL),
            aliases=aliases,
        )


def _safe_name(name: str, taken: set[str]) -> str:
    candidate = re.sub(r"\W", "_", name)
    if not candidate or candidate[0].isdigit():
        candidate = f"arg_{candidate}"
    while keyword.iskeyword(candidate) or keyword.issoftkeyword(candidate) or candidate in taken:
        candidate += "_"
    return candidate


def _friendly(name: str) -> str:
    return name.replace("_", " ")


def build_tool(spec: ToolSpec, ctx: RunContext) -> Tool:
    call_no = {"n": 0}

    def forward(self, *args: Any, **kwargs: Any):
        names = list(spec.inputs)
        kwargs.update(dict(zip(names, args)))
        payload = {spec.aliases.get(k, k): v for k, v in kwargs.items() if v is not None}

        ctx.spend_tool()
        if spec.name == "run_python":
            ctx.spend_python()
        call_no["n"] += 1
        call_id = f"{spec.name}-{call_no['n']}"
        label = spec.label or f"Running {_friendly(spec.name)}"

        ctx.state(spec.state, label)
        ctx.emit({"kind": "tool", "id": call_id, "name": spec.name, "status": "running",
                  "label": label, "mutating": spec.mutating, "args": _preview(payload)})
        try:
            result = ctx.call(
                "tool.invoke",
                {
                    "name": spec.name,
                    "args": payload,
                    "run": ctx.run_id,
                    "depth": ctx.depth,
                    "idem": _idem_key(ctx.run_id, spec, payload) if spec.mutating else None,
                },
                timeout=min(spec.timeout, max(5.0, ctx.remaining)),
            )
        except Cancelled:
            ctx.emit({"kind": "tool", "id": call_id, "name": spec.name, "status": "cancelled", "label": label})
            raise
        except HostError as exc:
            ctx.spend.tool_failures += 1
            if spec.name == "run_python":
                ctx.spend.python_failures += 1
            if "search" in spec.name or "source" in spec.name:
                ctx.spend.retrieval_failures += 1
            detail = str(exc)
            ctx.emit({"kind": "tool", "id": call_id, "name": spec.name, "status": "error",
                      "label": label, "detail": detail})
            ctx.state(EXECUTING)
            raise ToolFailed(f"{spec.name} failed: {detail}") from exc

        body = result.get("result") if isinstance(result, dict) and "result" in result else result
        ctx.emit({"kind": "tool", "id": call_id, "name": spec.name, "status": "ok", "label": label,
                  "detail": _detail(result), "result": _preview(body)})
        ctx.state(EXECUTING)
        return body

    params = [inspect.Parameter("self", inspect.Parameter.POSITIONAL_OR_KEYWORD)]
    for key, value in spec.inputs.items():
        optional = bool(value.get("nullable"))
        params.append(
            inspect.Parameter(
                key,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
                default=None if optional else inspect.Parameter.empty,
            )
        )
    forward.__signature__ = inspect.Signature(params)
    forward.__doc__ = spec.description

    cls = type(
        f"SalemTool_{spec.name}",
        (Tool,),
        {
            "name": spec.name,
            "description": spec.description,
            "inputs": spec.inputs,
            "output_type": spec.output_type,
            "forward": forward,
            "salem_spec": spec,
        },
    )
    return cls()


def _idem_key(run_id: str, spec: ToolSpec, args: dict) -> str:
    blob = json.dumps(args, sort_keys=True, default=str)
    return f"{run_id}:{spec.name}:{abs(hash(blob)):x}"


def _detail(result: Any) -> str:
    if isinstance(result, dict):
        for key in ("detail", "label", "message", "summary"):
            value = result.get(key)
            if isinstance(value, str) and value:
                return value
        if isinstance(result.get("result"), list):
            n = len(result["result"])
            return f"{n} result{'' if n == 1 else 's'}"
    if isinstance(result, list):
        return f"{len(result)} result{'' if len(result) == 1 else 's'}"
    return ""


def _preview(value: Any, limit: int = 600) -> Any:
    try:
        text = json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        text = str(value)
    return text if len(text) <= limit else text[:limit] + "…"


class Registry:
    def __init__(self, specs: list[dict]) -> None:
        self.specs: dict[str, ToolSpec] = {}
        for raw in specs:
            try:
                spec = ToolSpec.parse(raw)
            except (KeyError, TypeError, ValueError):
                continue
            self.specs[spec.name] = spec

    def names(self) -> list[str]:
        return sorted(self.specs)

    def select(self, ctx: RunContext, *, allow: list[str] | None = None, deny: list[str] | None = None,
               scopes: list[str] | None = None, read_only: bool = False) -> list[Tool]:
        out: list[Tool] = []
        for name, spec in sorted(self.specs.items()):
            if allow is not None and name not in allow:
                continue
            if deny and name in deny:
                continue
            if read_only and spec.mutating:
                continue
            if allow is None and scopes is not None and not set(spec.scopes) & set(scopes):
                continue
            try:
                out.append(build_tool(spec, ctx))
            except Exception as exc:
                ctx.host.log("error", f"tool {name!r} could not be built and was left out: {exc}")
        return out
