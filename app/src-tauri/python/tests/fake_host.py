"""A stand-in for the Rust host, so the runtime can be tested without the app.

It speaks the same protocol over a real pipe to a real `python -m salem_ai`
process: scripted model replies, tools that actually run, and a sandbox that
actually executes the code it is given. Nothing here mocks the runtime itself.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path

PACKAGE_ROOT = str(Path(__file__).resolve().parents[1])


class FakeHost:
    def __init__(self, replies, tools=None, sandbox=None, interpreter: str | None = None):
        self.replies = list(replies)
        self.tools = tools or {}
        self.sandbox = sandbox or (lambda code: {"ok": True, "stdout": "", "stderr": "", "result": None})
        self.events: list[dict] = []
        self.calls: list[tuple[str, dict]] = []
        self.saved: dict[str, dict] = {}
        self.telemetry: list[dict] = []
        self.hello: dict | None = None
        self._done: queue.Queue = queue.Queue()
        self._hello = threading.Event()
        env = dict(os.environ, PYTHONPATH=PACKAGE_ROOT, PYTHONUNBUFFERED="1")
        self.proc = subprocess.Popen(
            [interpreter or sys.executable, "-m", "salem_ai"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, env=env, bufsize=1,
        )
        threading.Thread(target=self._read, daemon=True).start()
        self._hello.wait(20)

    # ------------------------------------------------------------- protocol

    def send(self, message: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = message.get("t")
            if kind == "hello":
                self.hello = message
                self._hello.set()
            elif kind == "event":
                self.events.append(message["event"])
            elif kind == "done":
                self._done.put(message)
            elif kind == "call":
                # The real host answers on its own threads; a tool that blocks
                # must not stop cancels from getting through.
                threading.Thread(target=self._dispatch, args=(message,), daemon=True).start()

    def _dispatch(self, message: dict) -> None:
        method, args, call_id = message["method"], message["args"], message["id"]
        self.calls.append((method, args))
        try:
            self.send({"t": "reply", "id": call_id, "ok": True, "data": self._handle(method, args)})
        except Exception as exc:
            self.send({"t": "reply", "id": call_id, "ok": False, "error": str(exc)})

    def _handle(self, method: str, args: dict):
        if method == "model.complete":
            if not self.replies:
                raise RuntimeError("the test ran out of scripted model replies")
            reply = self.replies.pop(0)
            return reply(args) if callable(reply) else reply
        if method == "tool.invoke":
            handler = self.tools.get(args["name"])
            if handler is None:
                raise RuntimeError(f"no tool called {args['name']}")
            return handler(args["args"])
        if method == "python.run":
            return self.sandbox(args["code"])
        if method == "task.load":
            return self.saved.get(args["taskId"], {})
        if method == "task.save":
            self.saved[args["taskId"]] = args["state"]
            return {"ok": True}
        if method == "telemetry.record":
            self.telemetry.append(args)
            return {"ok": True}
        raise RuntimeError(f"unknown host method {method}")

    # ----------------------------------------------------------------- runs

    def run(self, payload: dict, run: str = "r1", timeout: float = 90) -> dict:
        self.send({"t": "start", "run": run, "input": payload})
        return self._done.get(timeout=timeout)

    def start(self, payload: dict, run: str = "r1") -> None:
        self.send({"t": "start", "run": run, "input": payload})

    def wait(self, timeout: float = 90) -> dict:
        return self._done.get(timeout=timeout)

    def cancel(self, run: str = "r1") -> None:
        self.send({"t": "cancel", "run": run})

    def close(self) -> None:
        try:
            self.send({"t": "shutdown"})
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
            self.proc.wait(timeout=5)
        for pipe in (self.proc.stdin, self.proc.stdout):
            try:
                if pipe is not None:
                    pipe.close()
            except Exception:
                pass

    # --------------------------------------------------------------- probes

    def states(self) -> list[str]:
        return [e["state"] for e in self.events if e.get("kind") == "state"]

    def of_kind(self, kind: str) -> list[dict]:
        return [e for e in self.events if e.get("kind") == kind]

    def model_calls(self) -> int:
        return sum(1 for method, _ in self.calls if method == "model.complete")


# ---------------------------------------------------------------- reply shapes


def says(text: str, prompt_tokens: int = 10, completion_tokens: int = 5) -> dict:
    return {"content": text, "usage": {"promptTokens": prompt_tokens, "completionTokens": completion_tokens}}


def calls(name: str, args: dict, call_id: str = "c1") -> dict:
    return {
        "content": "",
        "toolCalls": [{"id": call_id, "type": "function",
                       "function": {"name": name, "arguments": json.dumps(args)}}],
        "usage": {"promptTokens": 10, "completionTokens": 5},
    }


def writes_code(code: str) -> dict:
    """A code agent's reply: a thought and a Python block."""
    return {"content": f"Thought: I will work this out.\n```py\n{code}\n```<end_code>",
            "usage": {"promptTokens": 10, "completionTokens": 8}}


def real_sandbox(code: str) -> dict:
    """Runs the code for real, the way the app's sandbox does."""
    proc = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
    tail = (proc.stderr.strip().splitlines() or [""])[-1]
    return {"ok": proc.returncode == 0, "stdout": proc.stdout, "stderr": proc.stderr,
            "result": None, "error": None if proc.returncode == 0 else tail, "figures": []}
