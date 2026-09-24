from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import threading
import urllib.error
import urllib.request
from pathlib import Path

APP_ID = "net.serverside.webassign-desk"
HERE = Path(__file__).resolve().parent
RUNTIME = HERE.parent / "src-tauri" / "python"


def app_dir() -> Path:
    for candidate in (
        Path.home() / "Library" / "Application Support" / APP_ID,
        Path.home() / ".local" / "share" / APP_ID,
        Path(os.environ.get("APPDATA", "")) / APP_ID,
    ):
        if (candidate / "config.json").exists():
            return candidate
    sys.exit("No app data found. Open the app once, and set your API key in AI settings.")


APP = app_dir()
CFG = json.loads((APP / "config.json").read_text())
PYTHON = os.environ.get("WA_PYTHON") or str(APP / "python" / "venv" / "bin" / "python3")
if not CFG.get("api_key"):
    sys.exit("No API key in the app's config. Open AI settings and paste your key.")
if not Path(PYTHON).exists():
    sys.exit(f"No interpreter at {PYTHON}. Open AI settings -> Install, or set WA_PYTHON.")



def for_deepseek(messages: list) -> list:
    out = []
    for message in messages:
        message = dict(message)
        parts = message.get("content")
        if not isinstance(parts, list):
            out.append(message)
            continue
        has_image = any(p.get("type") == "image_url" for p in parts if isinstance(p, dict))
        if message.get("role") == "user" and has_image:
            out.append(message)
            continue
        message["content"] = "\n".join(
            p.get("text", "") for p in parts if isinstance(p, dict) and p.get("text")
        )
        out.append(message)
    return out


def complete(args: dict) -> dict:
    body = {
        "model": args.get("model") or CFG["flash_model"],
        "messages": for_deepseek(args.get("messages") or []),
        "stream": False,
        "max_tokens": 16384,
    }
    for key in ("tools", "tool_choice", "stop", "response_format"):
        if args.get(key) is not None:
            body[key] = args[key]
    if args.get("thinking"):
        body["thinking"] = {"type": "enabled"}
    say(f"POST {body['model']}  {len(body['messages'])} messages, "
        f"{len(body.get('tools') or [])} tools, tool_choice={body.get('tool_choice')}")
    request = urllib.request.Request(
        CFG["base_url"].rstrip("/") + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + CFG["api_key"], "Content-Type": "application/json"},
    )
    try:
        raw = urllib.request.urlopen(request, timeout=300).read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode()[:600]
        say(f"  HTTP {exc.code}: {detail}")
        raise RuntimeError(f"DeepSeek HTTP {exc.code}: {detail}") from exc
    parsed = json.loads(raw)
    message = parsed["choices"][0]["message"]
    calls = message.get("tool_calls") or []
    say("  " + (f"called {', '.join(c['function']['name'] for c in calls)}" if calls
                else repr(str(message.get("content"))[:120])))
    usage = parsed.get("usage") or {}
    return {
        "content": message.get("content") or "",
        "reasoning": message.get("reasoning_content") or "",
        "model": parsed.get("model") or "",
        "toolCalls": message.get("tool_calls"),
        "cancelled": False,
        "usage": {
            "promptTokens": usage.get("prompt_tokens", 0),
            "completionTokens": usage.get("completion_tokens", 0),
            "totalTokens": usage.get("total_tokens", 0),
        },
    }


WRAPPER = textwrap.dedent("""
    import json, sys, io, traceback
    src = json.load(open(sys.argv[1]))['code']
    out, err = io.StringIO(), io.StringIO()
    saved = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    failure = None
    try:
        exec(compile(src, '<salem>', 'exec'), {'__name__': '__main__'})
    except Exception:
        failure = traceback.format_exc(limit=4)
    finally:
        sys.stdout, sys.stderr = saved
    json.dump({'ok': failure is None, 'stdout': out.getvalue()[:20000],
               'stderr': err.getvalue()[:20000], 'result': None,
               'error': failure, 'figures': []}, open(sys.argv[2], 'w'))
""")


def sandbox(code: str) -> dict:
    say(f"python {code.strip()[:90]!r}")
    with tempfile.TemporaryDirectory() as tmp:
        job, result, script = f"{tmp}/job.json", f"{tmp}/out.json", f"{tmp}/run.py"
        Path(job).write_text(json.dumps({"code": code}))
        Path(script).write_text(WRAPPER)
        subprocess.run([PYTHON, script, job, result], capture_output=True, timeout=120)
        try:
            value = json.loads(Path(result).read_text())
        except Exception:
            value = {"ok": False, "stdout": "", "stderr": "", "result": None,
                     "error": "the sandbox wrote no result", "figures": []}
    say(f"  ok={value['ok']} {value['stdout'][:90]!r}")
    return value


TOOLS = [
    {"name": "list_sources", "description": "List the study sources in the current notebook.",
     "inputs": {}, "outputType": "object", "scopes": ["sources"],
     "label": "Looking through the sources"},
    {"name": "read_source", "description": "Read pages from one source.",
     "inputs": {"id": {"type": "integer", "description": "The source id."},
                "from_page": {"type": "integer", "description": "First page.", "nullable": True}},
     "outputType": "object", "scopes": ["sources"], "label": "Reading"},
    {"name": "run_python",
     "description": "Run Python in the app's sandbox and get its real output back. "
                    "Use it for every calculation. print() what you need.",
     "inputs": {"code": {"type": "string", "description": "The Python to run."}},
     "outputType": "object", "scopes": ["python"], "label": "Running Python",
     "state": "running_python", "timeout": 180},
]

SOURCE = ("Acute inflammation is the immediate response of vascularised tissue to injury. "
          "Its cardinal signs are redness, heat, swelling, pain and loss of function.")


def invoke(args: dict):
    name = args.get("name")
    payload = args.get("args") or {}
    if name == "list_sources":
        return {"result": [{"id": 1, "title": "MSK L1 inflammation", "pages": 40}],
                "label": "Listed 1 source"}
    if name == "read_source":
        return {"result": {"id": 1, "page": payload.get("from_page") or 1, "text": SOURCE},
                "label": "Read MSK L1"}
    if name == "run_python":
        return {"result": sandbox(payload.get("code") or "")}
    raise RuntimeError(f"no tool called {name}")


BASE = {
    "agent": "chat", "system": "You are helping with a medicine course.",
    "messages": [], "mode": "auto", "thinking": False, "model": CFG["flash_model"],
    "tools": TOOLS, "allow": None, "files": [], "sources": [], "schema": None,
    "budget": None, "feature": "chat",
}

def asks(text: str) -> list:
    return [{"role": "user", "content": text}]


CASES: dict[str, dict] = {
    "chat": {"messages": asks("What are the cardinal signs of acute inflammation in my sources?")},
    "notebook": {"agent": "notebook", "feature": "notebook",
                 "messages": asks("Summarise what my sources say about acute inflammation, "
                                  "and cite where it came from.")},
    "python": {"messages": asks("Work out 17 factorial divided by 15 factorial, using Python. "
                                "Show the number.")},
    "thinking": {"thinking": True,
                 "messages": asks("What are the cardinal signs of acute inflammation in my sources?")},
    "direct": {"mode": "direct", "messages": asks("Give this chat a three-word title: "
                                                  "a conversation about inflammation.")},
    "generation": {
        "agent": "generation", "feature": "quiz",
        "messages": asks("Make 2 multiple-choice questions from source 1 about acute inflammation."),
        "schema": {
            "type": "object", "required": ["questions"],
            "properties": {"questions": {"type": "array", "items": {
                "type": "object", "required": ["prompt", "choices", "answer"],
                "properties": {"prompt": {"type": "string"},
                               "choices": {"type": "array", "items": {"type": "string"}},
                               "answer": {"type": "integer"}}}}},
        },
    },
}


VERBOSE = os.environ.get("SALEM_VERBOSE") == "1"


def say(line: str) -> None:
    if VERBOSE:
        print(f"    {line}", file=sys.stderr)


def run_case(name: str) -> bool:
    print(f"\n=== {name}")
    proc = subprocess.Popen(
        [PYTHON, "-u", "-m", "salem_ai"], cwd=RUNTIME,
        env={**os.environ, "PYTHONPATH": str(RUNTIME)},
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    lock = threading.Lock()

    def send(message: dict) -> None:
        with lock:
            proc.stdin.write(json.dumps(message) + "\n")
            proc.stdin.flush()

    ok = False
    try:
        for line in proc.stdout:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = message.get("t")
            if kind == "hello":
                if not message.get("ok"):
                    print(f"    runtime refused to start: {message.get('error')}")
                    return False
                say(f"runtime {message.get('version')} on python {message.get('python')}, "
                    f"smolagents {message.get('smolagents')}")
                send({"t": "start", "run": "r1", "input": dict(BASE, **CASES[name])})
            elif kind == "event":
                event = message.get("event") or {}
                if event.get("kind") == "state":
                    say(f"[{event.get('state')}] {event.get('detail', '')}")
                elif event.get("kind") in ("tool", "subagent", "note"):
                    say(json.dumps(event)[:160])
            elif kind == "call":
                method, args, call_id = message["method"], message.get("args") or {}, message["id"]

                def serve(method=method, args=args, call_id=call_id):
                    try:
                        if method == "model.complete":
                            data = complete(args)
                        elif method == "tool.invoke":
                            data = invoke(args)
                        elif method == "python.run":
                            data = sandbox(args.get("code") or "")
                        elif method == "task.load":
                            data = None
                        elif method in ("task.save", "telemetry.record"):
                            data = {"ok": True}
                        else:
                            raise RuntimeError(f"no host method {method}")
                        send({"t": "reply", "id": call_id, "ok": True, "data": data})
                    except Exception as exc:
                        send({"t": "reply", "id": call_id, "ok": False, "error": str(exc)})

                threading.Thread(target=serve, daemon=True).start()
            elif kind == "done":
                ok = bool(message.get("ok"))
                result = message.get("result") or {}
                answer = result.get("structured") or result.get("text") or ""
                print(f"    {'ok' if ok else 'FAILED: ' + str(message.get('error'))}")
                if result.get("path") == "fallback":
                    ok = False
                    print("    FAILED: fell back to the tool-less path - "
                          f"{result.get('reason', '')[:200]}")
                telemetry = result.get("telemetry") or {}
                if telemetry:
                    print(f"    {telemetry.get('steps')} steps, "
                          f"{telemetry.get('tool_calls')} tool calls, "
                          f"{telemetry.get('python_calls')} python, "
                          f"{telemetry.get('subagents')} sub-agents, "
                          f"{telemetry.get('durationMs', 0) / 1000:.1f}s")
                text = json.dumps(answer) if not isinstance(answer, str) else answer
                print("    " + text.replace("\n", " ")[:300])
                break
    finally:
        proc.kill()
    return ok


def main() -> int:
    wanted = sys.argv[1:] or list(CASES)
    unknown = [name for name in wanted if name not in CASES]
    if unknown:
        sys.exit(f"No such case: {', '.join(unknown)}. Try: {', '.join(CASES)}")
    results = {name: run_case(name) for name in wanted}
    print()
    for name, ok in results.items():
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
