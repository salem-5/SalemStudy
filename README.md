# WebAssign MathPad console + local REST API + desktop app

Two pieces:

- **`webassign-mathpad.user.js`**: a Tampermonkey or Violentmonkey userscript. It adds `mp(...)` to the browser console for typing MathType answers. It also connects to the bridge and runs API calls inside your logged-in WebAssign tab.
- **`app/`**: WebAssign Desk, a Tauri + React desktop client. The bridge (the local HTTP server your CLI talks to) is built into it — there is no separate Node process.

```
CLI ──HTTP──▶ WebAssign Desk bridge (127.0.0.1:8787) ◀──long-poll── userscript in a webassign.net tab ──▶ WebAssign
```

Your session cookies stay in the browser. The bridge only relays jobs.

## Setup

1. Install `webassign-mathpad.user.js` in Tampermonkey or Violentmonkey. On the first bridge request, allow it to connect to `127.0.0.1`.
2. Run WebAssign Desk. It serves the bridge on `127.0.0.1:8787` while it is open.
3. Keep one webassign.net tab open and logged in. The console shows `[mp] REST bridge connected`, and the app's status bar shows `LINKED`.

Requests that carry an `http(s)` `Origin` header are rejected, so websites can't reach the bridge through your browser. Curl and your CLI send no Origin and are unaffected.

## REST API

Every response is JSON. Errors come back as `{"error": "..."}` with 400 (bad input), 401 (logged out), 404, 503 (no tab connected) or 504 (tab timed out).

| Method | Path | Returns |
|---|---|---|
| GET | `/api/status` | `{connected, page, queued, inFlight}` |
| GET | `/api/courses` | `[{id, courseId, sectionId, course, section, term, current}]` |
| GET | `/api/assignments[?section=ID]` | `{sectionId, current:[…], past:[…]}`. Defaults to the current course. |
| GET | `/api/assignments/:id[?html=1]` | `{id, name, questions:[Question]}` |
| GET | `/api/assignments/:id/questions/:n[?html=1]` | `Question` (`n` is the question number, starting at 1) |
| GET | `/api/assignments/:id/styles` | `{css, sources}`: WebAssign's question-layout CSS, scoped under `.qhtml` and recolored for dark backgrounds |
| POST | `/api/assignments/:id/questions/:n/save` | Saves progress. Uses no submission. |
| POST | `/api/assignments/:id/questions/:n/submit[?dryRun=1]` | Submits the question. Uses a submission. |
| POST | `/api/mathml` `{"expr": "..."}` | `{mathml, text}`: preview the conversion |

Each entry in the assignment lists looks like this:

```json
{"id": 40885121, "name": "12.3 (ET9)", "category": "Homework", "due": "2026-09-19T23:59+0300",
 "past": false, "score": null, "total": 30, "percentage": 0, "submitted": false, ...}
```

A **Question** looks like this:

```json
{
  "number": 6, "id": "5093822", "code": "SCalcET9M 12.3.024.",
  "score": null, "total": 3, "submissions": "0/5",
  "text": "Determine whether ... orthogonal, parallel, or neither.\n(a)\nu = ⟨−7, 4, −4⟩, ...\n[1] ○ orthogonal ○ parallel ○ neither ...",
  "boxes": [
    {"index": 1, "id": "RC_5093822_5_0_5097014", "type": "C", "typeName": "choice", "kind": "choice",
     "value": "2", "text": "2", "hint": null,
     "choices": [{"value": "0", "label": "orthogonal"}, {"value": "1", "label": "parallel"}, {"value": "2", "label": "neither"}],
     "part": {"score": null, "total": 1, "submissions": 0, "maxSubmissions": 5, "state": null}}
  ]
}
```

The `[n]` markers in `text` show where box `n` sits in the question.

With `?html=1`, each question also has `html`: WebAssign's own markup, sanitized, with image URLs made absolute. Every answer widget is replaced by a placeholder you render yourself:

- `<span class="wa-slot" data-box="n" [data-sub="k"]>` marks a text, math or dropdown box (`data-sub` numbers multi-dropdown boxes).
- `<span class="wa-opt" data-box="n" data-value="v">` marks each radio button or checkbox.
- Its label gets `class="wa-opt-label"` and the same `data-box` and `data-value` attributes.

Choice boxes also carry `display` (`dropdown`, `radio` or `checkbox`), and each choice has an `html` field holding its label markup, which may include images.

Each box has a `status` field (`correct`, `incorrect`, `partial`, `submitted` or `unanswered`, from the last submission) and a `mark` field with WebAssign's own message.

### Box kinds and what to send

| `kind` | Answer you send |
|---|---|
| `math` | Pad syntax such as `"<2p, -3q> . <p, 2q>"` or `"sqrt(x+1)/2"`, converted to MathML for you. A string starting with `<math` is sent unchanged. |
| `text`, `essay` | Plain string, e.g. `"-1/2"` |
| `choice` | A choice's `value` or `label`, e.g. `"parallel"` |
| `checkboxes` | Array (or comma-separated string) of values or labels |
| `multiselect` | Array with one value or label per dropdown |
| `unsupported` (graph, file, number line, …) | Raw response string only |

### Save and submit body

Pass `answers` as an array (box 1, box 2, …; use `null` to leave a box unchanged) or as an object keyed by box number, box letter or box id:

```json
{"answers": {"1": "orthogonal", "b": "parallel", "3": "neither"}}
```

Boxes you don't mention keep their current saved value. The request is built the same way the page builds it: every box of the question is sent.

- `save` returns `{saved, answers:[{index, kind, response, text, changed}]}`, or `saved:false` if nothing changed.
- `submit` returns `{submitted:true, allCorrect, results:[{index, status, score, total, submissions, maxSubmissions, message}], before, question}`. `results` is the per-part grade read from WebAssign's response right after grading, and `question` is the regraded question.
- `submit?dryRun=1` returns the exact URL and payload it would send, without sending it.

```bash
curl -s localhost:8787/api/assignments
curl -s localhost:8787/api/assignments/40885121/questions/2
curl -s -X POST localhost:8787/api/assignments/40885121/questions/2/submit?dryRun=1 -d '{"answers":["<2p,-3q> . <p,2q>"]}'
```

## Math syntax

This is shared by the API's `math` boxes and the console's `mp(...)`. Run `mp.help()` in the console for the full table.

`a/b`, `x^2`, `x_1`, `sqrt(x)`, `root(n, x)`, `sin(x)`…`arccoth(x)`, `sin^2(x)`, `ln(x)`, `log_2(x)`, `exp(x)`, `|x|`, `(a, b]`, `<1, 2, 3>`, `vec(v)`, `hat(u)`, `#i #j #k`, `*` or `.` for a dot, `<= >= !=`, `pi`, `inf`, `theta`, `Delta`, `DNE`, `undefined`, `nosolution`, `"text"`.

With `/`, the numerator is everything back to the last `+`, `-` or `,`, and the denominator is one factor. So `1/2x` means `(1/2)x`; write `1/(2x)` if you want 2x in the denominator.


## WebAssign Desk (desktop app)

```bash
cd app
npm install
npm run tauri dev      # development
npm run tauri build    # installers in app/src-tauri/target/release/bundle/
```

- The app serves the bridge itself on `127.0.0.1:8787`; no Node.js is required.
- Questions render from WebAssign's own markup and CSS. Dropdowns you can type into, radio and checkbox options (including image choices), and text boxes sit inline where WebAssign puts them.
- Each part shows whether your edit is **saved** on WebAssign, whether the last submission was **correct or wrong**, and attempts used. Drafts persist locally until saved.
- The math editor has live preview, autocomplete (Tab), templates (Ctrl+/ fraction, Ctrl+↑ power, Alt+R root, and more), smart brackets and history (Ctrl+Space). Press F1 for every shortcut.
- `npm run dev` without Tauri opens the UI in a browser using fixture data (`src/mock.ts`, `src/fixtures.ts`), for UI work.
- `src/lib/mathpad.js` is generated from the userscript by `npm run sync-mathpad`, which runs automatically before dev and build. Edit the parser in the userscript only.

### Solving with Python

The AI solver has a `run_python` tool and reaches for it whenever a question has to be worked out rather than recalled: it writes a snippet, reads the output, refines it, checks the answer a second way, and only then submits. Multiple-choice, definitions and one-step arithmetic are still answered directly. A question it got wrong by hand is retried with Python required.

Open **AI settings → Python** and press **Install**. The app finds a Python 3 on the machine (`WA_PYTHON`, the `PATH`, the usual install folders on Windows and macOS, and the `py` launcher on Windows), builds its own virtualenv under the app data folder, and installs `sympy`, `numpy`, `mpmath` and `scipy` into it. Nothing on your system Python is touched, and **Rebuild** starts the environment again from scratch.

Available to the model: `sympy` (as `sp`, with `solve`, `diff`, `integrate`, `limit`, `Matrix`, `simplify`, `nsimplify` and friends already in the namespace), `numpy` (`np`), `mpmath` (`mp`), `scipy`, plus `math`, `cmath`, `statistics`, `itertools`, `Fraction` and 50-digit `Decimal`. Each call starts from a fresh interpreter, prints what it wants to see, and a trailing bare expression is echoed back like a REPL.

Every run is sandboxed:

- a throwaway folder per run, deleted afterwards, and an environment scrubbed down to `PATH` and a temp dir;
- `-I` isolated mode, so no `PYTHON*` variables and no user site-packages;
- an audit hook that refuses subprocesses, sockets and any write outside that folder;
- POSIX limits on CPU, file size and address space;
- a timeout inside the runner, and the app killing the process if that is not enough.

Settings cover the seconds per run, the number of runs per attempt, whether Python is required for calculation questions or only after a wrong answer, and an interpreter path if you want a specific one. The `py` chip in the AI panel header shows whether the sandbox is ready.

The sandbox has its own tests, which need an interpreter to run against:

```bash
python3 -m venv /tmp/wa-py && /tmp/wa-py/bin/pip install sympy numpy mpmath
cd app/src-tauri && WA_TEST_PYTHON=/tmp/wa-py/bin/python cargo test --lib python
```

### Exporting a worksheet

Right-click an assignment (or select several) and choose **Export LaTeX / PDF**. The export turns the assignment into a worksheet: the question is typeset the way WebAssign renders it (real maths, figures at the size the app shows them, sub-parts, option lists), every answer widget becomes a named placeholder such as `A`, and each part gets somewhere to answer under the same letter: a box to write in, or — when the part is chosen from a list — the choices themselves, to tick. The answers WebAssign has graded correct are collected in a compact mark scheme on the last page.

Options in the export dialog:

- **Space for working** — a blank, framed area under each question.
- **Name & date fields** — the `Name / Class / Date` line under the title.
- **Readable text layer** — a plain-text copy of every question, the maths and each figure's description, typeset in invisible ink and taking no space. It never shows or prints, but anything that reads the PDF's text (a screen reader, NotebookLM, `pdftotext`) gets the question rather than a picture of it.
- Each row's **title** (what the sheet is called) and **file name** can be edited before exporting.

Files land in your Documents folder. The PDF needs a TeX engine, found in this order:

| Platform | Engine | Install |
|---|---|---|
| Windows | `pdflatex`, else `tectonic` | [MiKTeX](https://miktex.org/download) or [Tectonic](https://tectonic-typesetting.github.io/install.html) |
| macOS | `tectonic`, else `pdflatex` | `brew install tectonic`, or MacTeX |
| Linux | `tectonic`, else `pdflatex` | `sudo apt install tectonic` (or dnf/pacman/`cargo install tectonic`), or TeX Live |

`WA_PDFLATEX` and `WA_TECTONIC` override the search with a full path to the binary. Tectonic downloads what a document needs the first time it runs, so that first export wants a network connection. Without an engine, **Save .tex** still writes the LaTeX source.
