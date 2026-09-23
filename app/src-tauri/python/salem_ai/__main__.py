"""Entry point. `python -m salem_ai` and then talk to it over stdin/stdout.

The process is long-lived and handles several runs at once: each `start` gets
its own thread, so a background generation and a chat reply can be in flight
together, while the reader thread stays free to deliver `cancel` and the
replies the workers are parked on.
"""

from __future__ import annotations

import os
import sys
import threading
import traceback

# smolagents must not reach for the Hub, and nothing here should phone home.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")
os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")

from . import MIN_PYTHON, VERSION  # noqa: E402
from .rpc import Host  # noqa: E402


def main() -> int:
    # stdout is the protocol. Anything a library prints would corrupt it, so
    # the real stdout is taken away and given to the Host alone.
    protocol = sys.stdout
    sys.stdout = sys.stderr
    host = Host(stdin=sys.stdin, stdout=protocol)

    if sys.version_info < MIN_PYTHON:
        host.hello(ok=False, version=VERSION, python=".".join(map(str, sys.version_info[:3])),
                   error=f"Salem's AI needs Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]} or newer")
        return 1
    try:
        import smolagents
    except ImportError as exc:
        host.hello(ok=False, version=VERSION, python=".".join(map(str, sys.version_info[:3])),
                   error=f"smolagents is not installed in this environment ({exc})")
        return 1

    from .runtime import Runtime

    runtime = Runtime(host)

    def start(message: dict) -> None:
        run_id = str(message.get("run") or "")

        def work() -> None:
            try:
                runtime.start(message)
            except Exception:
                host.done(run_id, False, None, traceback.format_exc(limit=3))

        threading.Thread(target=work, name=f"salem-{run_id}", daemon=True).start()

    host.on("start", start)
    host.on("cancel", lambda m: runtime.cancel(str(m.get("run") or "")))
    host.on("ping", lambda m: host.log("debug", "pong"))

    host.hello(ok=True, version=VERSION, smolagents=smolagents.__version__,
               python=".".join(map(str, sys.version_info[:3])), executable=sys.executable)
    host.serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
