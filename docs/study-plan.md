# Study + Assignment Solver — plan

The app becomes two products behind one global sidebar:

- **Assignment Solver**: the existing WebAssign client and AI solver, unchanged in behaviour.
- **Study**: Subject → Notebook → Sources. Each notebook is its own NotebookLM-style workspace (sources, chat, map, flashcards, quizzes) with a hard context boundary.

## Decisions

| Question | Decision |
|---|---|
| Embeddings | Local: `fastembed` (ONNX) in Rust, `bge-small-en-v1.5`, downloaded on first use. Reranking with the same crate's `bge-reranker-base`. |
| Model | DeepSeek **Flash for everything**: ingestion profiles, planning, chat, cards, quizzes, verification. `proModel` stays in settings for the solver only. |
| Source types | PDF, slides (PPTX), images (incl. handwritten notes), text files (`.txt .md .tex` and code), YouTube. |
| Storage | One SQLite file (`study.db`) in the app data dir: `rusqlite` (bundled, FTS5) + `sqlite-vec`, vectors partitioned by `notebook_id`. |
| UI | Terminal-style, restrained: flat, no glow, no gradients, no gamey motion. Monospace for chrome and data, sans for reading. |
| Prompts | One per job, in `app/src/lib/prompts.ts`: standalone chat (general assistant), notebook chat (course tutor), flashcards, quizzes, short-answer grading. The assignment solver keeps its own prompt and its own compute-everything Python tool in `lib/ai.ts`; chats get a separate `run_python` whose description limits it to graphs, long computations and attached files. |
| Chat UI | [assistant-ui](https://www.assistant-ui.com) (`@assistant-ui/react`) on an external-store runtime: SQLite stays the source of truth, one `ChatView` serves the Chat tab and every notebook. Markdown via `marked`, maths via KaTeX, output sanitised with DOMPurify. |

## Principles

1. **The notebook boundary is enforced in SQL**, not the prompt: every retrieval query carries `notebook_id IN (:scope)`. Default scope is this notebook; subject / all is an explicit toggle.
2. **Embeddings are a retrieval mechanism, not understanding.** Each notebook keeps a topic tree and per-source profiles; the model reads those first, then retrieves.
3. **Hybrid search**: FTS5 BM25 + vectors, merged with reciprocal-rank fusion, then a local cross-encoder rerank.
4. **Citations are chunk IDs** (`[c183]`) checked against the retrieved set; the UI resolves them to source + page/slide/timestamp.
5. **Measure it**: a per-notebook eval set (question → sources that must be used) scores source recall on every retrieval change.

## Source types

Every type ends up as the same thing: ordered **units** (page / slide / image / timestamp span) → sections → chunks, each chunk carrying its unit span for citations.

| Type | Extraction | Unit (citation target) | Viewer |
|---|---|---|---|
| PDF | PyMuPDF in the managed venv (text + font sizes for headings). Pages that are scanned or maths-heavy are rendered to PNG and transcribed by Flash vision. | page | pdf.js, opened at the page with the chunk highlighted |
| Slides (PPTX) | `python-pptx`: slide text, speaker notes, tables; embedded images of equations/diagrams go through vision. | slide | Extracted slide cards; if LibreOffice is installed, convert to PDF for a faithful view |
| Images | Flash vision transcription (maths in LaTeX, diagrams described). Handwriting included. | image (region) | Image with the transcription beside it |
| Text files | Read directly; Markdown/LaTeX headings become sections. | line range | Text view scrolled to the range |
| YouTube | `yt-dlp` (pip, in the venv) fetches captions/auto-captions only, never the video. Chapters become sections. No captions → marked unsupported for now (local Whisper is a later option). | timestamp | Link opens the video at `t=` |

Extraction runs through the Python sandbox where it can (the file copied into the run folder); YouTube needs network, so it runs as a separate trusted step with network allowed and nothing else. `pint` and `PyMuPDF`, `python-pptx`, `yt-dlp` join the venv package list.

## Ingestion pipeline

```
file → units → sections → chunks (~400 tokens, unit span kept)
     → per-section Flash pass: topics, concepts, formulas, worked examples, definitions, prerequisites
     → source profile → merge into notebook topic tree → embed chunks → FTS index
```

Runs as a Rust background job (like `export_latex`) that emits progress events and survives navigation. Stages are idempotent, keyed on a content hash, so a crash resumes and a duplicate upload is free.

## Retrieval

- **Narrow / multi-source**: a planner agent reusing the solver's tool loop, with tools `get_notebook_map`, `list_sources`, `search(query, source_ids?, topic_ids?)`, `read_section(id)` and a forced `answer(text, citations[])`. Before `answer` it must state which map topics the question touches and which of those it has evidence for (coverage check); gaps trigger more retrieval.
- **Broad** ("what do I need for the midterm?"): no agent; deterministic map-reduce over every topic in the tree, then synthesis.
- **Follow-ups** are rewritten into standalone queries using the conversation before retrieval.
- **Conflicts**: flagged at answer time when evidence for one concept comes from ≥2 sources; the answer names the difference and cites both.
- **Subject shared context** (syllabus, notation, exam format) goes into the system prompt of every notebook in the subject, not into retrieval.

## Study material

Flashcards and quizzes live in the notebook's right pane, each with a list view, a focused mode and an analytics view. Both can be made by hand, from a topic prompt, from a chat ("Make flashcards" / "Quiz me on this"), or from selected sources, and always land in the current notebook.

### Flashcards

- **Card**: front, back (Markdown + LaTeX, optional figure), topic, source refs, FSRS state.
- **Review mode** (NotebookLM-style): one card at a time, centred. Click the card or press Space to flip it (3-D flip). Then mark it **✗ missed** or **✓ got it** (keys `1` / `2`, or ← / →). The card slides out and the next one comes in. A progress bar and a counter run along the top; the session ends with a summary (right / wrong, time, cards that go back into the queue).
- **Scheduling**: FSRS-5 with two grades, ✗ = *Again*, ✓ = *Good*. Missed cards come back later in the same session; target retention 90 %.
- **Decks**: "Due now" (default), "All", "By topic", "Missed last time".
- **Generation**: Flash writes cards as a forced tool call (one idea per card, no yes/no fronts); maths is checked in Python like quiz answers. Duplicates of existing cards are dropped.

### Quizzes

- **Question types**: multiple choice, true/false, numeric (with tolerance and optional units, checked with Pint), short answer (graded by Flash against the reference answer, with a rubric).
- **Flow**: one question per screen with a progress bar; answer → instant feedback (right/wrong, the worked solution, citation) → next. A results page at the end: score, time, per-topic breakdown, and "retry the ones I missed" / "make flashcards from my mistakes".
- **STEM verification**: Flash writes the problem, the answer and a check script; `run_python` (SymPy / SciPy / Pint) runs it; a mismatch means regenerate, up to N times. Conceptual items that cannot be checked symbolically are labelled *unverified* rather than silently dropped.
- **Figures**: a question can carry matplotlib code; it runs in the sandbox and the PNG is stored with the quiz.

### Analytics

Every flashcard review (`card_review`) and quiz attempt (`quiz_attempt`, with per-question answers) is stored, so the analytics view per notebook shows:

- reviews and accuracy per day (last 30 days), streak, time studied;
- cards due now / today / this week, and retention (share of ✓ on cards reviewed when due);
- per-topic accuracy across cards and quizzes, weakest topics first, each linking to a practice deck;
- quiz score history, and the questions missed most often.

## Standalone AI chat

A **Chat** entry in the sidebar: a plain assistant not tied to any notebook.

- Threads listed on the left, all saved in SQLite (every message, the Python it ran, figures, attachments).
- File uploads: images go to Flash vision; PDFs, text and data files are read as text; every file is also copied into the Python sandbox's folder, so the model can open a CSV or PDF in code.
- `run_python` tool with matplotlib: plots come back as images inline in the reply and are stored with the thread.
- "Make flashcards" / "Quiz me" on any thread, choosing the target notebook.

Notebook chats use the same storage and rendering (plus retrieval and citations).

## Python service

Shared by the solver, chat, notebooks and quizzes. Adds `matplotlib` (Agg; open figures and any saved image are returned as PNGs), `pint` (`ureg`, `Q_`), and `pymupdf` for PDFs, all optional installs next to scipy. Callers can hand it attachment IDs; those files are written into the run folder first.

## Pomodoro

A **Focus** entry in the sidebar, plus a timer chip in every view's top bar (click it to pause or resume, or to open Focus).

- Focus / short break / long break (25 / 5 / 15 minutes, a long break every 4 by default, all adjustable), auto-start of the next phase optional.
- A task list for the session: add what you plan to do, tick items off, carry unfinished ones over to the next one.
- When a phase ends: a chime (Web Audio, no asset), a dialog asking whether to start the break (or the next focus), and the window title flashes.
- History: focus minutes per day and the tasks completed in each session.

## Motion

Motion is quiet and functional: views cross-fade and rise a few pixels, lists stagger in briefly, sidebar folds and panes slide, tabs move an underline, progress bars ease, and the flashcard flips in 3-D. Durations stay between 120 and 320 ms with one easing curve, and everything respects `prefers-reduced-motion`.

## Data model

```
subject(id, name, context, position, created_at)
notebook(id, subject_id, name, description, position, created_at, updated_at)
source(id, notebook_id, kind, title, filename, hash, status, profile_json, created_at)
unit(id, source_id, ord, label, text)                    -- page / slide / image / timestamp span
section(id, source_id, parent_id, title, summary, unit_from, unit_to, meta_json)
chunk(id, section_id, source_id, notebook_id, ord, text, unit_from, unit_to, meta_json)
chunk_fts (FTS5 over chunk.text)          chunk_vec (sqlite-vec, partition key notebook_id)
topic(id, notebook_id, parent_id, name, summary)         topic_chunk(topic_id, chunk_id)
conversation(id, notebook_id NULL, title, created_at, updated_at)   -- NULL = standalone chat
message(id, conversation_id, role, content, meta_json, created_at)   -- meta: python runs, figures, attachments, citations
attachment(id, conversation_id, notebook_id, kind, name, mime, size, data, text, created_at)   -- uploads and figures
flashcard(id, notebook_id, front, back, topic, source_refs_json, fsrs_json, due_at, created_at)
card_review(id, card_id, notebook_id, correct, elapsed_ms, reviewed_at)
quiz(id, notebook_id, title, questions_json, created_at)
quiz_attempt(id, quiz_id, notebook_id, started_at, finished_at, score, total, answers_json)
job(id, notebook_id, source_id, kind, status, progress, error)
```

## Phases

| # | Scope | Done when |
|---|---|---|
| 0 ✓ | UI rework (terminal style). App shell with global sidebar (Solver / Study tree, collapsible subjects). SQLite + schema. Subject & notebook CRUD, subject page with notebook cards, empty notebook workspace. | You can create *Calculus II → Midterm Review*, open it, and switch back to the solver without losing its state. |
| 0.5 ✓ | Motion system. Pomodoro. Standalone chat with saved history, uploads, Python + matplotlib. Flashcards (manual + generated, flip review, ✓/✗, FSRS) and quizzes (generated, verified, taken, reviewed) with analytics, from a topic prompt until sources exist. | A chat thread survives a restart; a quiz question with a wrong check script never shows; analytics reflect reviews. |
| 0.8 ✓ | SalemStudy rename + icon. Schedule (calendar, AI-controllable). ⌘K search across every notebook. Notebook overviews. Code blocks with highlighting and copy. Picture extraction + description from PDFs/slides. Subject icons/colours, activity heatmap. All AI calls metered (`ai_usage`, by feature). Light/dark/system theme. | Settings shows one running total for everything that calls the AI. |
| 0.9 ✓ | Syllabus per subject (migration 6: file + text + AI summary that feeds course context; dated events reviewed into Schedule; `read_syllabus` tool). Scrolling month-stacked calendar. Accent colour. Assignment Solver behind a Features switch (off for new installs). Chat: natural voice prompt, personalization (about / how to respond / tone), Think mode with streamed reasoning, regenerate, edit-and-resend (`chat_truncate`), read aloud, starter prompts, dated + searchable + renamable chat list. | A syllabus PDF puts its exams on the calendar and the notebook tutor knows the grading. |
| 1 | Sources: all five types through extraction → units/sections/chunks → FTS. Job progress. Viewers. | Upload a PDF, a PPTX, an image, a `.md` and a YouTube link; each is searchable and opens at the right place. |
| 2 | Chat v1: local embeddings, hybrid search, rerank, streaming (`deepseek_stream`), chunk-ID citations, follow-up rewriting, conversation history. Eval set started. | Answers cite and open the right page; nothing leaks across notebooks. |
| 3 | Source intelligence: section/source profiles, topic tree (Map view), planner agent, coverage check, broad-query map-reduce. | Eval source recall clearly beats Phase 2. |
| 4 | Flashcards and quizzes grounded in sources and notebook chat (cited), "retry my mistakes", per-topic practice decks from the topic map. | Every generated item cites a source. |
| 5 | Scope toggle, subject shared context, conflict detection, "Send to Study" from an assignment (reuses the export text layer). | — |
