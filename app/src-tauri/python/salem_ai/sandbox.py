from __future__ import annotations

import json
from typing import Any

from smolagents.local_python_executor import CodeOutput
from smolagents import PythonExecutor, Tool

from .rpc import HostError
from .state import RunContext, RUNNING_PYTHON, EXECUTING

MAX_REPLAY_CHARS = 60_000

PREAMBLE = '''
import json as _json, sys as _sys
class _SalemFinal(BaseException):
    pass
def final_answer(value=None):
    """End the task and hand `value` back to the agent."""
    print("\\n__SALEM_FINAL__" + _json.dumps(value, default=str))
    raise _SalemFinal()
'''

_GUARD_OPEN = "try:\n"
_GUARD_CLOSE = "except _SalemFinal:\n    pass\n"


def _indent(code: str) -> str:
    return "".join(("    " + line if line.strip() else line) + "\n" for line in code.splitlines())


def run_in_sandbox(ctx: RunContext, code: str, *, files: list[int] | None = None,
                   sources: list[int] | None = None, timeout: float | None = None) -> dict:
    ctx.check()
    ctx.spend_python()
    return ctx.call(
        "python.run",
        {
            "code": code,
            "timeout": timeout,
            "files": files or [],
            "sources": sources or [],
            "run": ctx.run_id,
        },
        timeout=max(15.0, (timeout or 60.0) + 20.0),
    )


def format_result(result: dict) -> str:
    parts: list[str] = []
    stdout = (result.get("stdout") or "").strip()
    stderr = (result.get("stderr") or "").strip()
    value = result.get("result")
    error = result.get("error")
    if stdout:
        parts.append(f"stdout:\n{stdout[:6000]}")
    if value:
        parts.append(f"value of the last expression: {str(value)[:2000]}")
    if stderr:
        parts.append(f"stderr:\n{stderr[:2000]}")
    if error:
        parts.append(f"error:\n{str(error)[:3000]}")
    figures = result.get("figures") or []
    if figures:
        names = ", ".join(str(f.get("name") or "figure") for f in figures)
        parts.append(f"{len(figures)} figure(s) were captured and shown to the student: {names}.")
    if result.get("timed_out"):
        parts.append("It was stopped on time. Use a faster method (nsolve, fewer digits) and run it again.")
    if not parts:
        parts.append("The code ran but printed nothing. print() the values you need.")
    return "\n\n".join(parts)


class SandboxExecutor(PythonExecutor):
    def __init__(self, ctx: RunContext, *, files: list[int] | None = None,
                 sources: list[int] | None = None, timeout: float = 60.0) -> None:
        self.ctx = ctx
        self.files = files or []
        self.sources = sources or []
        self.timeout = timeout
        self.history: list[str] = []
        self.variables: dict[str, Any] = {}
        self.tool_names: list[str] = []

    def send_tools(self, tools: dict[str, Tool]) -> None:
        self.tool_names = [name for name in tools if name != "final_answer"]

    def send_variables(self, variables: dict[str, Any]) -> None:
        self.variables.update(variables)

    def __call__(self, code_action: str) -> CodeOutput:
        self.ctx.check()
        self.ctx.state(RUNNING_PYTHON, "Running Python")
        script = self._script(code_action)
        try:
            result = run_in_sandbox(self.ctx, script, files=self.files, sources=self.sources, timeout=self.timeout)
        except HostError as exc:
            self.ctx.spend.python_failures += 1
            self.ctx.state(EXECUTING)
            raise RuntimeError(f"the Python sandbox is unavailable: {exc}") from exc

        stdout = result.get("stdout") or ""
        final, stdout = _take_final(stdout)
        ok = bool(result.get("ok")) or final is not None
        if not ok:
            self.ctx.spend.python_failures += 1
        else:
            self.history.append(code_action)
        logs = format_result({**result, "stdout": stdout})
        self.ctx.emit({
            "kind": "python", "status": "ok" if ok else "error",
            "code": code_action[:4000], "output": logs[:4000],
            "figures": [f.get("name") for f in (result.get("figures") or [])],
        })
        self.ctx.state(EXECUTING)
        if not ok:
            raise RuntimeError(logs)
        return CodeOutput(output=final if final is not None else result.get("result"),
                          logs=logs, is_final_answer=final is not None)

    def _script(self, code: str) -> str:
        replay = ""
        kept: list[str] = []
        total = 0
        for block in reversed(self.history):
            total += len(block)
            if total > MAX_REPLAY_CHARS:
                break
            kept.append(block)
        if kept:
            body = "\n".join(reversed(kept))
            replay = (
                "import contextlib as _ctx, io as _io\n"
                "with _ctx.redirect_stdout(_io.StringIO()), _ctx.redirect_stderr(_io.StringIO()):\n"
                f"{_indent(body)}"
            )
        seeds = "".join(f"{k} = {v!r}\n" for k, v in self.variables.items() if _reprable(v))
        return f"{PREAMBLE}\n{seeds}{replay}\n{_GUARD_OPEN}{_indent(code)}{_GUARD_CLOSE}"

    def cleanup(self) -> None:
        self.history.clear()


def _reprable(value: Any) -> bool:
    return isinstance(value, (str, int, float, bool, type(None), list, dict, tuple))


def _take_final(stdout: str) -> tuple[Any | None, str]:
    marker = "__SALEM_FINAL__"
    at = stdout.rfind(marker)
    if at < 0:
        return None, stdout
    line_end = stdout.find("\n", at)
    blob = stdout[at + len(marker): line_end if line_end >= 0 else len(stdout)]
    rest = stdout[:at] + (stdout[line_end + 1:] if line_end >= 0 else "")
    try:
        return json.loads(blob), rest
    except json.JSONDecodeError:
        return blob, rest
