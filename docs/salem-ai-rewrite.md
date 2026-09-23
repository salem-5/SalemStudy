# Salem AI rewrite — progress

Every item below comes from the specification. Checked = written **and** covered
by a passing test or verified by hand. Unchecked = not started or in progress.

Status: **runtime landed and chat runs on it; study features in progress.**
Test suites: `npm test` (80) · `npm run test:rust` (63) · `npm run test:ai` (20).

---

## 1. Core architecture

- [x] Salem AI layer rebuilt on Hugging Face smolagents (`app/src-tauri/python/salem_ai/`)
- [x] smolagents kept behind a Salem abstraction — the app speaks a JSON-lines
      protocol, never smolagents types
- [x] One execution architecture for chat, reasoning, tool calling, retrieval,
      Python, structured generation and agentic work
- [x] UI, persistence, app state, permissions, sources and the database stay
      outside smolagents (the runtime holds no key, no socket, no SQLite handle)
- [x] Every AI feature routed through it: chat, notebook chat, thinking,
      quizzes, flashcards, notes, overviews, syllabus reading, image and PDF
      transcription, chat titles, short-answer marking and the solver
- [x] Nothing outside `lib/salem` calls a model any more
- [x] The old per-feature AI loops are gone: `chatEngine`'s turn loop, the
      solver's own tool loop and sandbox runner, the forced-tool-call
      generator. What is left in those files is app logic

## 2. Salem AI runtime

- [x] Central runtime (`salem_ai/runtime.py`) with model execution, context,
      task state, memory, tools, retrieval, Python, sub-agents, retries,
      timeouts, cancellation, validation, error recovery, execution state
- [x] Routes each request to a direct or an agentic path
- [x] Simple requests stay one round trip; a tool request escalates by itself
- [x] Rust host (`src-tauri/src/salem.rs`) — process supervisor, model proxy,
      sandbox, tool dispatch, task state, telemetry

## 3. Agents

- [x] Chat agent — conversation, tools, web search
- [x] Notebook agent — source-grounded, read-only, iterative retrieval
- [x] Task agent — multi-step, tools, Python, sub-agents, validation
- [x] Generation agent — schema-validated study material
- [x] Sub-agents: PDF extraction, date/schedule validation, source retrieval,
      Python/data processing, schedule verification, quiz and flashcard checks
- [x] All share one runtime, tool layer and reliability machinery

## 4. Chat, thinking and agentic modes

- [x] Normal chat goes through the runtime, not a direct model call
- [x] Web search available and preferred for current or uncertain facts
- [x] Thinking mode on the same runtime, with a larger budget
- [x] Stall and runaway detection, timeouts, tool-failure recovery, retries,
      and a simpler fallback path when the agent is stuck
- [x] No thinking request can hang: every run ends completed, failed,
      cancelled or timed out
- [x] Private chain-of-thought never leaves the runtime
- [x] Agentic escalation on multi-tool / bulk / extraction-shaped requests
- [x] Bounded by execution, token, tool-call and sub-agent limits

## 5. Tool calling and the tool layer

- [x] All tool calls go through the runtime and execute the real tool
- [x] No fabricated tool messages — a tool call is a host call or it fails
- [x] Explicit per-call state: running, completed, failed, cancelled
- [x] The agent receives the actual result or the actual error
- [x] Strict typed schemas, validated before the call leaves
- [x] Read-only vs mutating marked; read-only agents never see mutating tools
- [x] Idempotency keys so a retry cannot apply the same mutation twice
- [x] No direct database access from the agent
- [x] Tool registry (`lib/salem/tools.ts`) covering the schedule, calendar,
      notebooks, notes, sources, flashcards, quizzes, search, web, Python
      and the focus timer
- [x] A source-creation tool, so the main chat can save material into any
      notebook
- [ ] Assignment tools

## 6. Persistent task state

- [x] Compact working memory, kept apart from the raw conversation
- [x] Stores objective, constraints, dates, numbers, entities, done, pending,
      tool results, decisions, validations, expected final state, unresolved
- [x] Task ids, saved to SQLite, resumable after an interruption
- [x] Context compaction that preserves the task state
- [x] Compaction can never rewrite the objective
- [x] Recent turns always survive compaction

## 7. Sub-agent limits

- [x] Maximum depth, count, execution time and token usage
- [x] Recursive and runaway delegation prevented
- [x] Structured results, integrated and validated by the parent

## 8. Python execution

- [x] First-class tool, and a smolagents `CodeAgent` executor
- [x] Really executes — the app's existing sandbox, audit hook and timeout
- [x] Reuses Salem's virtualenv; no second environment
- [x] Errors returned to the agent for recovery
- [x] State carried across code blocks by replaying earlier blocks
- [x] Only the files and sources the task was given

## 9. Large structured tasks

- [x] Automatic detection and escalation
- [x] Structured data before application, Python for normalisation
- [x] Sub-agents for independent validation
- [x] Prompts require the original value beside the normalised one
- [x] Ambiguity reported, never guessed
- [ ] End-to-end yearly-schedule PDF import wired into the Schedule page

## 10. Source retrieval

- [x] Iterative retrieval through the unified runtime
- [x] Retrieval budgets prevent infinite search loops
- [x] Provenance returned with every passage (source, page, id)
- [x] A source-backed question shows where it came from in its feedback
- [ ] Notebook chat citations carried through the agent's own retrieval
- [x] The notebook agent is told that running out of retrieved text is not
      the same as the material not covering it, and how to go and get the rest
- [ ] Unsupported source-specific claims blocked in the notebook UI

## 11. Web search

- [x] Available as a Salem tool, served natively by Rust
- [x] Results reach the agent as real tool results
- [x] Notebook chat hard-bounded to its selected sources — a source id it was
      not given is refused, not quietly widened
- [x] Notebook chat told to use the web only when the sources cannot answer
- [x] Quiz and flashcard generation hard-blocked from web search (the
      generation allow-list has no web tools in it)
- [ ] Source URLs preserved in the rendered answer

## 12. Source extraction

- [x] OCR and vision extraction, through the runtime
- [ ] PDF page rendering when text extraction is insufficient
- [x] Extraction report on every source: empty pages, repeated pages,
      figure pages not read, how many were transcribed
- [x] Page numbers and order preserved; empty and duplicated pages detected
      and shown on the source row

## 13. Quizzes

- [x] Generation through the Generation agent
- [x] Single-select, multi-select, true/false, numeric, short and
      fill-in-the-blank, each with its own marking rules
- [x] Configurable difficulty, answer positions shuffled after the check,
      distractors required to be plausible and same-domain
- [x] Source attribution (the question records the excerpt it came from) and
      LaTeX throughout
- [x] Subtle hints for every question type, dropped automatically when they
      give the answer away
- [x] Preview before finalising; regenerate a single question
- [x] Background generation for large quizzes (12 or more), with a tray
- [x] Persisted generation options

### Quiz navigation
- [x] Free navigation and a question navigator
- [x] Unanswered / answered / correct / incorrect states (not colour alone)
- [x] Answers preserved and changeable before submission
- [x] Full review after completion, with hints and explanations

### Ask AI from a quiz answer
- [x] "Ask AI" after every question, right or wrong
- [x] Opens a normal Salem chat, pre-loaded with the question context
- [x] Never changes the answer or the score
- [x] Conversation persisted and tied to the question
- [x] Calculations independently verified before being explained

## 14. Flashcards

- [x] Generation through the Generation agent
- [x] Cloze (fill-the-gap) cards, and one question per card enforced in the
      prompt and the schema
- [ ] Automated atomic-fact validation by a checking sub-agent
- [x]Every card records the source it came from
- [ ] Automated quality validation
- [x] Background generation for large decks, configurable size, shuffling
- [x] Progress, learning state and resumable sessions

## 15. Scroll and session persistence

- [x] Quiz progress persisted: answers, position, drafts, hints used
- [x] Flashcard progress persisted: cards seen, results, position
- [x] An interrupted study session can be resumed, and says so
- [x] Saved state survives an application restart
- [x] AI explanation conversations persisted
- [x] Generation settings persisted per notebook
- [x] Chat scroll position saved and restored, per chat, across restarts
- [x] Stable message anchor alongside the raw offset
- [x] Note scroll position saved and restored per note

## 16. Assignment solver and schedule

- [x] Due dates cached and reconciled instead of re-queried, and shown from
      the cache when the bridge is down
- [x] An assignment that stops being listed is marked, not deleted; a moved
      due date is picked up and flagged
- [ ] Agentic execution for large imports; Python for date processing
- [x] An unreadable date never overwrites a known one

## 17. Activity

- [x] Quiz, flashcard, note, source, chat and finished-focus-session activity
- [x] Timestamps only — no conversation content in activity

## 18. Dependency setup and onboarding

- [x] Detects Python, the virtualenv, and what is missing
- [x] Detects and installs smolagents
- [x] Requires and finds Python ≥ 3.10 (macOS ships 3.9 — the environment is
      rebuilt on a newer interpreter)
- [x] One environment shared by the AI runtime and Python execution
- [x] Runtime failures surfaced in Settings ("Not running: …")
- [x] Surfaced during first-run onboarding, with install buttons
- [x] Python, the AI runtime and Tectonic all install from the onboarding
      page — no terminal, except on Linux where TeX needs a password

## 19. Tab mode

- [x] Localhost web server on 127.0.0.1 (`src-tauri/src/tabmode.rs`)
- [x] Same UI, backend, runtime, persistence and state — the tab relays every
      command through the window, so the two cannot drift apart
- [x] Sidebar button and the URL to open
- [x] 256-bit token from the OS, compared in full, stripped from the address
      bar; a request carrying a website's Origin is refused outright

## 20. Execution state

- [x] Planning, executing, waiting for tool, waiting for sub-agent, running
      Python, retrieving, validating, retrying, completed, failed, cancelled
- [x] Emitted to the app without exposing chain-of-thought
- [x] Rendered in the chat UI

## 21. Validation and reliability

- [x] Structured output validated against a schema before it is applied
- [x] Tool arguments validated against their schemas
- [x] Retries, with only the failed part retried where possible
- [x] Never reports success when the underlying operation failed
- [x] Never substitutes guessed data
- [x] Cancellation, timeouts, loop prevention
- [x] Task state preserved on failure; partial work recoverable
- [ ] Independent verification of calculations, dates and answer keys wired
      into the generation flows

## 22. Concurrency

- [x] Runs are asynchronous; several can be in flight at once
- [x] Long jobs do not block the UI thread
- [x] Data versioning so a stale run cannot overwrite newer state
- [x] Task-level locking: a second job on the same notebook's quizzes or
      decks is refused, with the reason, rather than racing the first
- [x] Background task tray: what is running, how far it has got, stop it,
      or click through to the result

## 23. Telemetry

- [x] Duration, tool failures, retries, completion and failure rates, tokens,
      Python failures, retrieval failures
- [x] No user content logged
- [x] Kept apart from working memory
- [x] Shown in Settings → AI runtime, with a restart button

## 24. Testing

- [x] Runtime tested independently of the app
- [x] Tool schemas and validation
- [x] Retries and failure recovery
- [x] Context compaction
- [x] Sub-agent delegation
- [x] Python execution
- [x] Cancellation and timeouts
- [x] Persistence round-trip (Rust)
- [x] The tool declaration contract (TypeScript → runtime) tested
- [x] The marking rules tested independently of the AI (35 cases)
- [ ] Each Salem tool body unit-tested independently of the AI
- [ ] Large PDF extraction, yearly schedule import, date normalisation
- [x] Quiz navigation and answer persistence
- [x] Quiz generation against a validated schema
- [ ] Answer-key validation by the checking sub-agent
- [x] Flashcard progress persistence
- [ ] Flashcard generation quality
- [x] Chat and note scroll restoration
- [x] Tab mode's access rules and event feed
- [ ] Restart recovery and concurrent background tasks


---

## 25. Follow-up requests (second round)

- [x] Quiz: the numbered question cards are gone; the progress bar is back
- [x] Quiz: Previous and Next inset with padding, and carried over to decks
- [x] Quiz: opening one shows an overview first — every question, its type,
      topic, difficulty and answer — with "go to" and "edit" on each
- [x] Quiz: edit any question, including its answer key, hint and explanation
- [x] Decks: free movement through the deck without marking a card
      (Previous/Next, and shift+arrows)
- [x] Decks: "Ask AI about this card", with the card's two sides as context
- [x] A chat button in the top bar of quizzes, decks and notes, open from
      anywhere without losing your place
- [x] The chat is told what you were looking at — the question, the card or
      the note — without volunteering a quiz answer you did not ask for
- [x] The first message carries a visible tag (`**[Quiz · Q3]**`) so the
      thread still makes sense in the chat list later
- [x] The main chat can read and search your notes (`list_notes`, `read_note`,
      `search_notes`)
- [x] Quizzes and decks can be generated from your notes as well as your sources
- [x] Quiz generation takes a difficulty and a set of question types, both
      remembered per notebook
- [x] Regenerate a single question with the AI, from the overview or the
      preview — it lands in the editor to be read before it counts
- [x] Preview a generated quiz before it is saved: rename it, edit, rewrite
      or drop any question, or discard the lot

## 26. Follow-up requests (third round — the hand-written notes)

See [salem-notes.md](salem-notes.md) for the notes themselves.

- [x] Notebook chats can page through a whole source, not just one retrieved
      excerpt, and are told to do so before giving up
- [x] The main chat can create sources and add them to any notebook
- [x] Quiz: pick which question types to include
- [x] Quiz: difficulty when generating
- [x] Quiz: generated in the background, with a loading card in the Quizzes list
- [x] Quiz: last options remembered per notebook
- [x] Quiz: the right answer no longer always lands first
- [x] Quiz: hints on every question type
- [x] Quiz: fill-in-the-blank with a gap in the sentence, and a hint button
- [x] Quiz: each question records the source it came from
- [x] Quiz: maths renders in the options, the feedback and the overview
- [x] Quiz: every question visible before playing
- [x] Quiz: progress saved
- [x] No Python check forced on biology questions — the subject decides
- [x] Flashcards: one point per card, in the reference's format
- [x] Flashcards: Fewer / Standard / More, where Standard is a complete
      page-by-page pass and More adds comparison and application cards
- [x] Flashcards: in source order unless shuffle is on
- [x] Flashcards: shuffle remembered globally
- [x] Flashcards: each card records its source
- [x] Flashcards: difficulty when generating
- [x] Flashcards: generated in the background with a loading card
- [x] Flashcards: progress saved
- [x] The model is tuned separately for STEM, life sciences and business
- [x] Web search: free in the main chat, only when needed in a notebook, never
      for quizzes or flashcards
- [x] Assignment due dates cached, so the Schedule shows them without the
      userscript running
- [x] Click a day in the activity map to see which subjects and notebooks
- [x] Onboarding page for missing dependencies, with install buttons
- [x] Tab mode


## 27. Follow-up requests (fourth round)

- [x] **The AI failing everywhere** — smolagents hands every message an array
      of content parts; DeepSeek only accepts that for a user message carrying
      an image, so every single call was being rejected. The adapter now
      flattens text-only messages back to strings
- [x] A runtime that started and said it could not work is no longer cached
      for the life of the window, so installing what was missing fixes the app
      without restarting it
- [x] Installing or repairing Python restarts the runtime
- [x] Settings shows *why* the runtime would not start, including what Python
      printed on its way out
- [x] Normal chats go through an agent, so the assistant looks things up,
      checks the maths and searches the web instead of answering from memory
- [x] Notebook chats get a larger budget, since grounding takes several reads
- [x] Reference notes, quizzes and flashcards from any chat
      (`list_study_material`, `read_quiz`, `read_deck`, `read_note`,
      `search_notes`)
- [x] A right-click menu on selected text, with Copy
- [x] "Ask AI about this" on a selection in a note, a quiz question or a card
- [x] What was referenced is shown like an attachment, with the words quoted,
      and the assistant is told to read around it before answering
- [x] Tab mode's dialog has padding
- [x] The quiz's resume line is a button in the top bar
- [x] Previous / Next / Finish have icons and padding, and no longer flash a
      scrollbar while the card animates
- [x] The browser tab shows the current app mark
- [x] **PDF export moved off LaTeX entirely.** Notes and worksheets are laid
      out by PyMuPDF with matplotlib for the formulas, in the environment the
      app already keeps. Tectonic and MiKTeX are gone, along with the TeX
      discovery, the installer and 450 lines of LaTeX emitters

## 28. Why every AI task was still failing

Reported as "all ai tasks still fail" after the message-shape fix in §27. That
fix was real — an array `content` on a system message is rejected — but it was
not the whole story, and the rest of it was only visible from a run against the
live API. Both halves of the stack had been tested against scripted replies,
which is exactly the kind of failure a fake model cannot show you.

- [x] **`tool_choice: "required"` is rejected by every DeepSeek model on this
      account.** They all reason before they answer, and the API refuses a
      forced tool choice on a thinking model: `HTTP 400 — "Thinking mode does
      not support this tool_choice"`. The runtime sent it on every agent step,
      so the first step of every agentic run died, all three retries died the
      same way, and the run fell through to the tool-less fallback. That is
      why chat came back vague and hedged, and why anything that needed
      structured data — a quiz, a deck, a set of notes — produced nothing at
      all: the fallback path answers in prose and has no schema to satisfy.
      The tool choice is now `"auto"`, which is what the endpoint supports
- [x] Verified against the live API rather than a fake: chat, notebook,
      thinking, the direct path, the Python sandbox and a schema-constrained
      generation (sub-agents, `quiz_checker`, Python validation and all) each
      run end to end and come back grounded in the sources they were given
- [x] **That verification is now a script**, `npm run test:ai:live`. It starts
      the real runtime with the app's own interpreter, answers its calls the
      way `salem.rs` does, and sends `model.complete` to DeepSeek for real. It
      spends tokens, so it is not part of `npm test` — but it is the only
      thing that can catch a request the API rejects, and a run that quietly
      degrades to the tool-less path is reported as a failure rather than a
      pass. Run it after touching the model adapter, the message conversion
      or the tool specs
- [x] **A reply written as prose no longer ends a run by accident.** Without a
      forced tool choice the model sometimes writes instead of calling, and
      mid-task prose ("let me check the next page") reads exactly like a
      finished answer. The first one is refused, so a model with more to do
      carries on; a model that does it twice running has its answer taken
      rather than spending the rest of the run's steps being asked again
- [x] A test pins the request shape, so a forced tool choice cannot come back
- [x] Two tests pin the prose behaviour from both sides: accepted when it is
      the answer, refused when the run had more to do

What was checked and found sound, so it is not the cause: the key and both
model names are valid; `thinking` (enabled and disabled) and `reasoning_effort`
are accepted; the streaming shape matches what the accumulator expects; token
usage is converted correctly on the way back; and the managed environment is
Python 3.14.6 with smolagents 1.26.0, which handshakes in well under a second.

## 29. Why it was still failing in the app

Reported as "nothing at all in the app that uses ai works", after §28 had the
runtime answering correctly from outside. Both halves were right and the app
was still dead, because nothing had ever run the AI *through the webview* —
where the study space, the tool registry and every real tool declaration live.

- [x] **`read_source` declares an input called `from`.** On this side every
      declared tool becomes a real Python function, and `inspect.Parameter`
      will not take a keyword as a parameter name. The `ValueError` came
      straight out of `select()`, before the agent's first step, so one
      awkward name in one tool was every agentic feature in the app failing at
      once. Names that Python cannot take are now adjusted, and `forward` puts
      the declared name back before the call leaves
- [x] **An optional argument declared before a required one** produced the
      same kind of death — "non-default argument follows default argument".
      Arguments are now ordered required-first when the signature is built
- [x] A tool that still cannot be built costs that tool, not the run
- [x] **`gradeShort` could never have worked**: the one-pass path ignored the
      schema entirely and returned prose, so every caller with a schema threw
      "the model did not produce anything usable". The one-pass path now asks
      for the JSON, validates it, and escalates to the agent when it does not
      fit — it is allowed to be wrong, not to hand back something wrong
- [x] **The app runs its own smoke test now**: `npm run test:ai:app` boots the
      desktop app with `VITE_SELFTEST=1` and exercises chat, generation and
      the real generators over the student's own notebook, reporting from
      inside the webview. It is what found all of the above

## 30. Making it faster

Measured in the app, on the student's own Calculus 2 slides.

| | before | after |
|---|---|---|
| chat turn, with tools | 5.5s | 4.0s |
| flashcards, 5 from the slides | — | 8.8s |
| quiz, 3 from the slides | 143s, failed | 83s, 3 kept, 0 dropped |

- [x] **Generation is one pass by default.** It is handed its material in the
      prompt, so there is nothing to go and find; the agent loop was re-sending
      that material on every step, which is how three questions reached eight
      hundred thousand tokens and hit the budget. The runtime escalates by
      itself when the model reaches for a tool or writes something that does
      not fit, so a quiz that really does need Python still gets it — the
      flashcards above never left the cheap path
- [x] **The checking sub-agents are only offered where something computes.**
      Each one taken is a nested agent loop with its own steps and its own
      context. A course whose answer keys are prose has nothing for a checker
      to recompute, and every question already carries `check_code` that is
      re-derived on the app's side anyway
- [x] **How hard to think is a setting** — Fast / Balanced / Thorough in AI
      settings, defaulting to Fast. An agent spends most of its steps choosing
      a tool, where the API's own default reasons at length for nothing:
      measured on this account, an answer step costs 6.4s at `high` against
      4.2s at `low`, and a tool-choosing step is the same either way
- [x] Sub-agents always reason at `low`. Their work is mechanical

## 31. The agent, kept for when it earns its place

Asked for after §30: normal chat and all generation back to plain model calls,
with smolagents kept wired up and reached for only when a turn genuinely needs
it. Measured in the app, on the same Calculus 2 slides as §30.

| | agentic (§30) | now |
|---|---|---|
| chat turn, with tools | 4.0s | **2.0s** |
| flashcards, 5 from the slides | 8.8s | **2.8s** |
| quiz, 3 from the slides | 83s, 3 kept | **10.6s, 3 kept, 0 dropped** |
| a genuinely demanding turn | — | 26s, hands over to the agent |

- [x] **Generation is a plain model call again** — quizzes, decks, notes,
      titles, grading, image reading. It is always handed its material in the
      prompt, so there was never anything for an agent to go and find
- [x] **Normal chat is a streaming tool loop again** (`toolLoop.ts`): it
      answers from the first token, and a question needing one lookup costs
      one lookup. It has the same tools the agent had, so referencing notes,
      quizzes and decks all still work
- [x] **A turn earns the agent by behaving like a demanding one.** Four rounds
      of tool calls in and still reaching for more is what importing a year's
      schedule out of a PDF looks like, and what asking a definition does not.
      At that point the work so far is handed over and the runtime takes the
      turn, in fast mode. Verified in the app: an ordinary turn stays on the
      loop at 2s, a deliberately demanding one hands over and finishes 20 tool
      calls later
- [x] One place decides which tools a turn may use, and the agent inherits
      exactly that list, so the two paths cannot drift apart
- [x] **The forced tool call the old code used is gone for good.** DeepSeek
      refuses `tool_choice` on a thinking model whether you ask for `required`
      or name a function, so "the way it was" is not literally available: the
      shape is asked for as JSON, checked here against the schema
      (`schemaCheck.ts`, 15 tests) and retried with the reason when it does
      not fit
- [x] The Python verification is unchanged in kind and sharper in practice: a
      question whose own `check_code` does not reproduce its answer key is
      still thrown away, but the retry is now told *what* disagreed rather
      than just that something did. That is the difference between 2 of 3
      questions surviving and 3 of 3
- [x] Flashcards keep the page-by-page pass over the lecture, the size tiers
      and the per-card provenance
- [x] smolagents, the runtime, the Rust host and all 31 of their tests stay
      exactly where they are — nothing normal use touches, everything a
      demanding turn needs

## 32. Work you started, and what it was about

- [x] **Leaving a chat no longer throws the answer away.** A turn used to live
      inside the view that started it, and switching away cancelled the
      stream, so the only safe thing to do was sit and wait. It lives in a
      store now (`chatRuns.ts`, 10 tests): leaving leaves it running, coming
      back picks it up mid-sentence, and the reply is saved whether anyone is
      watching or not
- [x] Stop cuts the request that is actually in flight. The two paths a turn
      can take are cancelled differently, so the turn hands out its own
      canceller rather than the store guessing from an id
- [x] **The sidebar says when something is happening where you cannot see it**
      — a dot on Chat while an answer is being written, one on Study while
      something is being made
- [x] **The card standing in for a quiz or deck being written is the way into
      what it is doing.** Every step is kept with its timestamp, and clicking
      the card reads them back: which pass it is on, which question failed its
      check and is being replaced. A spinner says it has not died; this says
      where it has got to
- [x] **A reference is handed over with its material.** Pointing at a line in
      a note used to send the assistant the line and directions for finding
      the rest, which cost it two or three tool calls before it could start on
      the actual question — while the student watched it look up something
      they had open in front of them. The note, question, card or the pages
      around a slide are fetched while the sheet opens and written into the
      briefing. Verified in the app: the material arrives, and the briefing no
      longer tells it to go and read_quiz
- [x] **The chip moved to the composer, where an attachment sits**, and says
      only what it is. The whole quotation across the top of the sheet was
      giving up the top of the screen to something the student had just been
      reading; hovering gives it back
- [x] Asking about a quiz question or a flashcard shows that chip too, so it
      is as clear there what the assistant was handed. Its briefing already
      spells the question out, so the reference is marked as briefed and not
      described twice
- [x] The selection menu lost its drop shadow

## 33. A reference belongs to the message, not the chat

Reported: selecting a paragraph about sequences and asking "explain this" got
back an explanation of the squeeze theorem and lim sin(x)/x — the subject of an
*earlier* question in the same thread. And: "the attached reference isn't sent
to the prompt, it's kept in the bar where I type the message, it's not like
files at all."

Both are the same defect. The reference was written into the chat's system
prompt, and the sheet reopens the same conversation for the same note — so a
new selection changed the framing of a thread the model was already reading
from the middle of, and the newest thing it had actually been *told* was the
last question. It answered that one.

- [x] **A reference travels with the message it was attached to**, the way a
      file does. It is stored on that message, written into that turn, shown
      on it in the transcript afterwards, and cleared from the composer once
      it has gone — because what the student was pointing at when they asked
      is part of *that* question, not of everything they ask next
- [x] The system prompt no longer carries it, so a second selection in the
      same note cannot be read against the first
- [x] A briefed reference — a quiz question or card, where the chat was opened
      about it and the briefing already spells it out — stays pinned to the
      composer instead, and is not sent again with every message
- [x] Verified in the app: the chip sits in the composer, goes with the
      message, clears, and appears on the sent message; the turn that reaches
      the model starts with what was selected
- [x] `reference.ts` has its own tests now (10), including that a reference
      whose material was fetched does not also tell the assistant to go and
      fetch it

## 34. Decks and quizzes walk the material, page by page

A deck used to be "write 80 cards from these excerpts". The number came first
and the material second, so a long lecture was sampled and a short one padded,
and the cards came out in whatever order the model thought of them. The way a
student uses a deck is to read a lecture, drill until they hit a card on
something they have not read yet, then read on. That needs cards that follow
the lecture page by page and leave nothing out.

- [x] **Reading order.** Sources go in the order their titles claim ("Lecture
      3", "Part II", "03 - Intro", "Week three"), then in the order they were
      added. The dialog shows the order numbered and lets the student move
      any source up or down (`deckPlan.readingOrder` / `applyOrder`)
- [x] **The walk.** Every source is cut into runs of consecutive pages of
      about 6,000 characters (`planWalk`), never splitting a page or crossing
      into the next source. Each run gets its own pass, three at a time. Every
      pass is shown *all* of the material (or its own source in full and the
      rest in outline, past 180,000 characters), then told which pages are its
      own. The shared prefix is cached by the provider after the first pass
- [x] **How many.** Nothing is chosen up front. Each pass is told the rough
      scale its pages usually come to, as a sense of scale and not a quota
      (a shown ceiling becomes a target). That scale is the student's own
      reference deck's density (one card per ~275 characters where it was
      complete), applied to these pages' length. A short lecture gets a short
      deck and nothing is padded
- [x] **The settings are ceilings, always in order** (`budgets`). Standard is
      at most 86, More at most 128, Fewer at most 52. However little material
      there is, Fewer < Standard < More. A number asked for in chat replaces
      the setting, capped at what More would make of the material
- [x] **Fewer** is written as Standard is, with every item tagged core or
      detail, then cut down: details go, then the trim keeps the core. Asked
      directly for "only the essentials", the model wrote everything anyway
- [x] **Trimming never loses a page** (`balancedTrim`). Every page keeps its
      first core item, then the remaining room goes to pages in proportion to
      how much each wrote, so a dense page keeps more than a title slide
- [x] **Every page, checked.** A pass sometimes stops early (seven cards,
      then nothing after the fourth of nine pages). After each pass, any page
      with content and no item gets a second, smaller pass of its own
      (`uncovered`). Dividers and the title slide are not chased. An item
      that names a page outside its pass is dropped rather than filed under
      the wrong page
- [x] **Naming** is one small call over the topics the deck covers, in order.
      Named by a pass, a deck about four diseases was called after the first
- [x] A card or question never mentions "page 12" or "the diagram". The
      student answers without the material open
- [x] **Fill the gap** has a real box in the sentence. The gap is swapped for a
      marker, the Markdown is rendered whole, and an input is portalled into
      the marker's place (`GapPrompt`). It grows with the answer and turns
      green or red once checked. Lists of questions show an empty box, not
      underscores
- [x] A quiz pass whose multiple-choice `answer` came back as `2` rather than
      `"2"` failed its shape check and was thrown away: six passes in seven.
      The checker now reads a number and the same number as text as one
      answer, and a failed pass says why in the task's progress
- [x] A blank with two gaps is refused: there is one box and one answer
- [x] Benchmarked in the app on the student's 49-page pathology lecture
      (`VITE_SELFTEST=walk`), against their reference deck of 55 cards that
      stops around page 31. Final run: Standard 86 cards (20s), Fewer 52
      (20s), More 128 (20s), quiz 86 questions (69s; 37 mcq, 20 short, 16
      blank, 8 select-all, 4 true/false, 1 numeric). All four cover every
      content page, in page order. None mentions a page, and none is filed
      under the title slide

## 35. Decks and quizzes are one thing until they are played

Decks and quizzes had grown apart. They had different rows in the notebook's
pane (a deck had Play and a menu, a quiz had only ×). They had different
pages. A quiz, once written, came up in a "Your quiz is ready" dialog and was
lost unless the student clicked Save. And both announced themselves in a
floating tray. To a student they are the same kind of thing, a set made from
their material and played for a score, so now they share everything up to
the moment of playing (`study/StudySets.tsx`).

- [x] **Making one** is one path (`lib/makeSet.ts`): write it, save it. The
      generate dialog and the chat assistant both use it. There is no preview
      and no save click. A quiz can be read over, edited, rewritten or deleted
      from its own page like a deck
- [x] **In the background, without a toast.** The dialog closes as soon as the
      job starts. The set being written sits at the top of its list (click
      for the steps, × to stop). Its tab shows a spinner, so it can be seen
      from Notes. The floating tray is gone: it was a second place saying
      what the list already said
- [x] **When it lands** it becomes an ordinary row marked *new* until opened,
      with a warning if part of the material could not be written. It does
      not throw itself open, because the student may be in the middle of
      something else
- [x] **One row** for decks, quizzes and notes: icon, title (two lines rather
      than cut off), counts and scores, Play, ⋯ and the same right-click
      menu (Play or Carry on, Open, Rename, Delete)
- [x] **One page** (`SetPage`): back, title, rename, ask about it, delete; the
      count, best and last; the play buttons; then the items as numbered rows
      (`SetItem`), each with how it went last time. Only the play buttons
      and what an item shows differ
- [x] Renaming or deleting from the list updates or closes the page showing it
- [x] Fixed on the way: `loadPrefs` spread a plain value into an object, so
      "shuffle" came back as `{}` (truthy) and could never stay off. Playing
      from the list now follows the shuffle setting too
- [x] Verified in the app: the self-test writes a quiz and a deck through
      `makeSet` against the live API, reads each back from the database and
      deletes it (6 questions, 8 cards). The browser preview covered the
      shared pane, page, menu, rename both ways, and a failed job's row

## 36. What things cost, fast mode, and maths that no longer turns red

- [x] **Every piece of work shows its price.** The Rust side already logged each
      call's cost for Settings; it now also returns it with the reply
      (`cost`), and agent runs emit a `usage` event per model call. A `Meter`
      (`lib/meter.ts`) is passed down explicitly to add these up per piece of
      work. It is not ambient state, because a deck, a quiz and two chats can
      all run at once.
  - Decks and quizzes: live on the generating row and in its details. Kept
    afterwards (`rememberCost`) and shown on the row and as "to make" on the
    set's page.
  - Chat replies: under every reply, counting up while it is written. Saved
    on the message (`meta.cost`), in every chat: the notebook's, the
    assistant's, and the ones opened about a card or a question.
  - Notes: in the header while written, and afterwards. A refined note shows
    the total of all its writes.
- [x] **Fast mode** for decks and quizzes, on by default and remembered.
      Windows are twice the size (half the passes) and six run at once. Each
      pass sees an outline of everything plus its own pages in full, instead
      of the whole material. Each pass is told its share firmly ("about N, no
      more than N+15%"), since output is most of the price. Fewer is told
      its own number instead of writing a Standard deck and discarding most
      of it. Quiz explanations and hints are kept short. Measured on the
      49-page lecture:

      | | cards/questions | time | cost |
      |---|---|---|---|
      | Deck, standard, fast | 86 | 11s | $0.0053 |
      | Deck, standard, thorough | 86 | 15s | $0.0069 |
      | Deck, fewer, fast | 52 | 8s | $0.0042 |
      | Deck, more, fast | 128 | 12s | $0.0064 |
      | Quiz, standard, fast | 86 | 23s | $0.0111 |
      | Quiz, standard, thorough | 86 | 90s | $0.0294 |

      Every content page is covered in each, except page 20 (four image
      captions) in Fewer and fast Standard.
- [x] **Quiz types** all ticked by default. All ticked means "whichever suits
      each point", not "use every type". The last one cannot be unticked
- [x] **Shuffle** is one setting for every deck. It could never be turned off
      before, because `loadPrefs` spread the saved `false` into `{}`
- [x] **Red maths.** Every formula in the student's decks and quizzes was run
      through KaTeX; four failed and two showed as raw LaTeX:
  - A fill-the-gap blank inside the maths (`\frac{a\cdot b}{_____}`,
    `\text{_____}`), where the underscores read as subscripts: now drawn as a
    line (`repairTex`).
  - `$… = $ _____`, maths closed after a space, which the inline rule
    rejected: accepted when it holds a LaTeX command.
  - Answers written as bare LaTeX (`-\mathbf{b}`): typeset (`asMath`).
  - Anything still unparseable is shown as quiet source text, not KaTeX's red
    error.
  - The prompts now say a gap never goes inside `$…$`. All stored formulas
    now typeset (0 errors).
- [x] An optional field off its list (`importance: "medium"`) no longer fails
      a whole pass of questions. The schema check lets optional values
      through, and the reader drops them one item at a time
- [x] Verified in the app against the live API: a chat reply, a demanding one
      handed to the agent, and a saved quiz all came back with a price
