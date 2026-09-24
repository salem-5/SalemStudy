import ast
import io
import json
import os
import sys
import threading
import time
import traceback
import _thread

JOB_PATH, RESULT_PATH = sys.argv[1], sys.argv[2]

with open(JOB_PATH, encoding="utf-8") as fh:
    JOB = json.load(fh)

CODE = JOB.get("code") or ""
TIMEOUT = float(JOB.get("timeout", 20))
MEMORY_MB = int(JOB.get("memory_mb", 4096))
MAX_OUTPUT = int(JOB.get("max_output", 20000))
MAX_FIGURES = int(JOB.get("max_figures", 8))
MAX_FIGURE_BYTES = 4 * 1024 * 1024
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp")
SANDBOX = os.path.normcase(os.path.realpath(os.getcwd()))


def write_result(payload):
    payload.setdefault("stdout", "")
    payload.setdefault("stderr", "")
    payload.setdefault("result", None)
    payload.setdefault("error", None)
    tmp = RESULT_PATH + ".part"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    os.replace(tmp, RESULT_PATH)


def apply_limits():
    try:
        import resource
    except ImportError:
        return
    cpu = max(1, int(TIMEOUT) + 2)
    limits = [
        ("RLIMIT_CPU", (cpu, cpu + 2)),
        ("RLIMIT_FSIZE", (32 * 1024 * 1024,) * 2),
        ("RLIMIT_NOFILE", (256, 256)),
        ("RLIMIT_CORE", (0, 0)),
    ]
    if MEMORY_MB > 0 and sys.platform != "darwin":
        limits.append(("RLIMIT_AS", (MEMORY_MB * 1024 * 1024,) * 2))
    for name, value in limits:
        limit = getattr(resource, name, None)
        if limit is None:
            continue
        try:
            soft, hard = resource.getrlimit(limit)
            want_soft, want_hard = value
            if hard != resource.RLIM_INFINITY:
                want_soft = min(want_soft, hard)
                want_hard = min(want_hard, hard)
            resource.setrlimit(limit, (want_soft, want_hard))
        except (ValueError, OSError):
            pass


class Denied(RuntimeError):
    pass


PROCESS_EVENTS = (
    "subprocess.Popen", "os.system", "os.exec", "os.spawn", "os.posix_spawn",
    "os.fork", "os.forkpty", "pty.spawn", "webbrowser.open", "os.startfile",
)
NETWORK_EVENTS = (
    "socket.connect", "socket.bind", "socket.getaddrinfo", "socket.gethostbyname",
    "socket.gethostbyaddr", "socket.sendto", "socket.sendmsg", "socket.__new__",
    "urllib.Request", "ftplib.connect", "smtplib.connect", "imaplib.open",
    "poplib.connect", "telnetlib.Telnet", "http.client.connect",
)
WRITE_EVENTS = (
    "os.remove", "os.rename", "os.mkdir", "os.rmdir", "os.chmod", "os.chown",
    "os.link", "os.symlink", "os.truncate", "os.utime", "shutil.copyfile",
    "shutil.copymode", "shutil.copystat", "shutil.move", "shutil.rmtree",
    "shutil.unpack_archive", "os.setuid", "os.setgid",
)
WRITE_FLAGS = (
    getattr(os, "O_WRONLY", 0) | getattr(os, "O_RDWR", 0) | getattr(os, "O_CREAT", 0)
    | getattr(os, "O_APPEND", 0) | getattr(os, "O_TRUNC", 0)
)


def inside_sandbox(path):
    try:
        real = os.path.normcase(os.path.realpath(os.fspath(path)))
    except (TypeError, ValueError):
        return False
    return real == SANDBOX or real.startswith(SANDBOX + os.sep)


def audit(event, args):
    if event in PROCESS_EVENTS or event.startswith("subprocess."):
        raise Denied(f"the sandbox does not allow running programs ({event})")
    if event in NETWORK_EVENTS:
        raise Denied(f"the sandbox has no network access ({event})")
    if event == "open":
        path, mode, flags = (list(args) + [None, None, None])[:3]
        writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
            isinstance(flags, int) and bool(flags & WRITE_FLAGS)
        )
        if writing and path is not None and not inside_sandbox(path):
            raise Denied("the sandbox can only write inside its own folder")
        return
    if event in WRITE_EVENTS:
        if event == "os.mkdir" and args and isinstance(args[0], (str, bytes, os.PathLike)) and os.path.isdir(args[0]):
            return
        for arg in args:
            if isinstance(arg, (str, bytes, os.PathLike)) and not inside_sandbox(arg):
                raise Denied(f"the sandbox can only touch files in its own folder ({event})")


def build_namespace():
    ns = {"__name__": "__main__", "__builtins__": __builtins__}
    loaded, failed = [], []
    for alias, module in (
        ("sp", "sympy"), ("sympy", "sympy"), ("np", "numpy"), ("numpy", "numpy"),
        ("mp", "mpmath"), ("mpmath", "mpmath"), ("math", "math"), ("cmath", "cmath"),
        ("itertools", "itertools"), ("functools", "functools"), ("statistics", "statistics"),
        ("random", "random"), ("re", "re"), ("json", "json"),
    ):
        try:
            ns[alias] = __import__(module)
            if module not in loaded:
                loaded.append(module)
        except Exception:
            if module not in failed:
                failed.append(module)
    try:
        from fractions import Fraction
        from decimal import Decimal, getcontext
        getcontext().prec = 50
        ns["Fraction"] = Fraction
        ns["Decimal"] = Decimal
    except Exception:
        pass
    if any(word in CODE for word in ("plt", "matplotlib", "pyplot")):
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
            plt.show = lambda *args, **kwargs: None
            plt.rcParams["figure.dpi"] = 110
            ns["matplotlib"] = matplotlib
            ns["plt"] = plt
            loaded.append("matplotlib")
        except Exception:
            failed.append("matplotlib")
    if "pint" in CODE or "ureg" in CODE or "Q_(" in CODE:
        try:
            import pint
            ureg = pint.UnitRegistry()
            ns["pint"] = pint
            ns["ureg"] = ureg
            ns["Q_"] = ureg.Quantity
            loaded.append("pint")
        except Exception:
            failed.append("pint")
    if "fitz" in CODE or "pymupdf" in CODE:
        try:
            import pymupdf
            ns["pymupdf"] = pymupdf
            ns["fitz"] = pymupdf
            loaded.append("pymupdf")
        except Exception:
            failed.append("pymupdf")
    sympy = ns.get("sympy")
    if sympy is not None:
        for name in (
            "symbols", "Symbol", "S", "Eq", "solve", "solveset", "nsolve", "simplify",
            "expand", "factor", "diff", "integrate", "limit", "series", "Matrix",
            "sqrt", "pi", "E", "I", "oo", "exp", "log", "sin", "cos", "tan", "asin",
            "acos", "atan", "atan2", "sinh", "cosh", "tanh", "Rational", "N", "nsimplify",
            "latex", "summation", "Sum", "Product", "binomial", "factorial", "gcd", "lcm",
        ):
            if hasattr(sympy, name):
                ns.setdefault(name, getattr(sympy, name))
    return ns, loaded, failed


NAMESPACE, LOADED, FAILED = build_namespace()


def clip(text):
    if len(text) <= MAX_OUTPUT:
        return text, False
    return text[:MAX_OUTPUT] + f"\n… [{len(text) - MAX_OUTPUT} more characters cut]", True


def describe(value):
    try:
        text = repr(value)
    except Exception:
        return "<unrepresentable value>"
    sympy = NAMESPACE.get("sympy")
    if sympy is not None:
        try:
            if isinstance(value, sympy.Basic):
                pretty = sympy.sstr(value)
                if pretty != text:
                    return f"{pretty}"
        except Exception:
            pass
    return text


def collect_figures(before):
    names = []
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None:
        for i, num in enumerate(plt.get_fignums()[:MAX_FIGURES], start=1):
            name = f"_figure-{i}.png"
            try:
                plt.figure(num).savefig(name, dpi=150, bbox_inches="tight")
                names.append(name)
            except Exception:
                pass
    try:
        for entry in sorted(os.listdir(".")):
            if entry in before or entry.startswith("_") or not entry.lower().endswith(IMAGE_EXTS):
                continue
            names.append(entry)
    except OSError:
        pass
    return [n for n in names if os.path.getsize(n) <= MAX_FIGURE_BYTES][:MAX_FIGURES]


FINISHED = threading.Event()


def watchdog():
    if not FINISHED.wait(TIMEOUT):
        _thread.interrupt_main()


def main():
    apply_limits()
    out, err = io.StringIO(), io.StringIO()
    result_repr = None
    error = None
    timed_out = False
    started = time.time()

    try:
        tree = ast.parse(CODE, filename="<answer>", mode="exec")
    except SyntaxError as exc:
        write_result({
            "ok": False,
            "error": "".join(traceback.format_exception_only(type(exc), exc)).strip(),
            "duration_ms": 0,
            "loaded": LOADED,
            "missing": FAILED,
        })
        return

    tail = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        tail = ast.Expression(tree.body.pop().value)

    body = compile(tree, "<answer>", "exec")
    tail_code = compile(tail, "<answer>", "eval") if tail is not None else None

    before = set(os.listdir("."))
    sys.addaudithook(audit)
    threading.Thread(target=watchdog, daemon=True).start()
    real_out, real_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    try:
        exec(body, NAMESPACE, NAMESPACE)
        if tail_code is not None:
            value = eval(tail_code, NAMESPACE, NAMESPACE)
            if value is not None:
                result_repr = describe(value)
    except KeyboardInterrupt:
        timed_out = True
        error = f"the code was still running after {TIMEOUT:g}s and was stopped"
    except Denied as exc:
        error = f"blocked by the sandbox: {exc}"
    except SystemExit:
        pass
    except MemoryError:
        error = "the code ran out of memory in the sandbox"
    except BaseException:
        lines = traceback.format_exception(*sys.exc_info())
        error = "".join([lines[0]] + [ln for ln in lines[1:] if "sandbox_runner.py" not in ln]).strip()
    finally:
        FINISHED.set()
        sys.stdout, sys.stderr = real_out, real_err

    figures = []
    if not timed_out:
        try:
            figures = collect_figures(before)
        except Exception:
            figures = []

    stdout, cut_out = clip(out.getvalue())
    stderr, cut_err = clip(err.getvalue())
    write_result({
        "ok": error is None,
        "stdout": stdout,
        "stderr": stderr,
        "result": result_repr,
        "error": error,
        "timed_out": timed_out,
        "truncated": cut_out or cut_err,
        "figures": figures,
        "duration_ms": int((time.time() - started) * 1000),
        "loaded": LOADED,
        "missing": FAILED,
    })


try:
    main()
except BaseException:
    try:
        write_result({"ok": False, "error": "the sandbox runner failed:\n" + traceback.format_exc()})
    except Exception:
        pass
    raise
