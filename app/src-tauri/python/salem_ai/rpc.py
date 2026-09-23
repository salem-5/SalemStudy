"""Line-delimited JSON over stdio, between the runtime and the Rust host.

The runtime never talks to the network, the database or the user's files on
its own: everything it needs it asks the host for, and the host is the only
side that holds the API key, the SQLite handle and the sandbox. That keeps
"UI, persistence, application state, permissions, source management and
database operations" outside smolagents, as the architecture requires.

Two directions share one pipe:

  host -> runtime   start / cancel / reply / shutdown
  runtime -> host   hello / call / event / done / log

`call` is the only one that blocks: a worker thread parks on a `Future` until
the reader thread hands back the matching `reply`. Everything else is fire and
forget, so a run can keep streaming while another waits on a tool.
"""

from __future__ import annotations

import json
import sys
import time
import threading
from dataclasses import dataclass, field
from typing import Any, Callable


class HostError(RuntimeError):
    """The host refused or failed a call. Agents catch these and recover."""


class Cancelled(RuntimeError):
    """The user stopped this run. Never reported as a failure."""


@dataclass
class _Pending:
    done: threading.Event = field(default_factory=threading.Event)
    ok: bool = False
    data: Any = None
    error: str = ""


class Host:
    """The other end of the pipe. One instance per process."""

    def __init__(self, stdin=None, stdout=None) -> None:
        self._in = stdin or sys.stdin
        self._out = stdout or sys.stdout
        self._write_lock = threading.Lock()
        self._pending: dict[int, _Pending] = {}
        self._pending_lock = threading.Lock()
        self._next_id = 0
        self._handlers: dict[str, Callable[[dict], None]] = {}
        self._closed = threading.Event()

    # ---------------------------------------------------------------- writing

    def _send(self, payload: dict) -> None:
        line = json.dumps(payload, ensure_ascii=False, default=str)
        with self._write_lock:
            try:
                self._out.write(line + "\n")
                self._out.flush()
            except (BrokenPipeError, ValueError):
                self._closed.set()

    def hello(self, **info: Any) -> None:
        self._send({"t": "hello", **info})

    def log(self, level: str, message: str) -> None:
        self._send({"t": "log", "level": level, "message": message})

    def event(self, run: str, event: dict) -> None:
        """A progress event for one run. The UI renders these; they must never
        carry private chain-of-thought, only the states listed in `state.py`."""
        self._send({"t": "event", "run": run, "event": event})

    def done(self, run: str, ok: bool, result: Any = None, error: str = "") -> None:
        self._send({"t": "done", "run": run, "ok": ok, "result": result, "error": error})

    # ---------------------------------------------------------------- calling

    def call(self, method: str, args: dict, timeout: float | None = None,
             abort: threading.Event | None = None) -> Any:
        """Ask the host to do something and wait for its answer.

        Raises `HostError` on a refusal, a timeout or a closed pipe — always a
        real error the agent can see and recover from, never a fabricated
        success — and `Cancelled` the moment `abort` is set, so stopping a run
        does not have to wait out a slow tool. The host is told to abandon the
        work it had started for us.
        """
        if self._closed.is_set():
            raise HostError("the app is no longer listening")
        if abort is not None and abort.is_set():
            raise Cancelled("stopped")
        with self._pending_lock:
            self._next_id += 1
            call_id = self._next_id
            slot = _Pending()
            self._pending[call_id] = slot
        self._send({"t": "call", "id": call_id, "method": method, "args": args})

        deadline = None if timeout is None else time.monotonic() + timeout
        while not slot.done.wait(0.1 if abort is not None else (timeout or 0.5)):
            if abort is not None and abort.is_set():
                self._abandon(call_id, "stopped")
                raise Cancelled("stopped")
            if deadline is not None and time.monotonic() >= deadline:
                self._abandon(call_id, "timed out")
                raise HostError(f"{method} did not answer in {timeout:.0f}s")
            if self._closed.is_set():
                self._abandon(call_id, "closed")
                raise HostError("the app closed the connection")
        if not slot.ok:
            raise HostError(slot.error or f"{method} failed")
        return slot.data

    def _abandon(self, call_id: int, why: str) -> None:
        """Stop waiting, and let the host drop whatever it started for us."""
        with self._pending_lock:
            self._pending.pop(call_id, None)
        self._send({"t": "abandon", "id": call_id, "reason": why})

    # ---------------------------------------------------------------- reading

    def on(self, kind: str, handler: Callable[[dict], None]) -> None:
        self._handlers[kind] = handler

    def serve(self) -> None:
        """Read messages until stdin closes or the host asks us to stop."""
        for line in self._in:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                self.log("warn", "ignored a malformed line from the host")
                continue
            kind = msg.get("t")
            if kind == "reply":
                self._resolve(msg)
                continue
            if kind == "shutdown":
                break
            handler = self._handlers.get(kind or "")
            if handler is None:
                self.log("warn", f"no handler for {kind!r}")
                continue
            try:
                handler(msg)
            except Exception as exc:  # a bad message must not kill the runtime
                self.log("error", f"{kind} handler failed: {exc}")
        self.close()

    def _resolve(self, msg: dict) -> None:
        with self._pending_lock:
            slot = self._pending.pop(int(msg.get("id", -1)), None)
        if slot is None:
            return
        slot.ok = bool(msg.get("ok"))
        slot.data = msg.get("data")
        slot.error = str(msg.get("error") or "")
        slot.done.set()

    def close(self) -> None:
        """Fail every waiting call, so no worker thread is left parked."""
        self._closed.set()
        with self._pending_lock:
            waiting = list(self._pending.values())
            self._pending.clear()
        for slot in waiting:
            slot.ok = False
            slot.error = "the app closed the connection"
            slot.done.set()
