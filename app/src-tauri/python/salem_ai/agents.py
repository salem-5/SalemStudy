"""The Salem agents. One runtime, several shapes of the same machinery.

Every agent here is built from the same pieces — `HostModel`, the tool
registry, the sandbox, `RunContext` — and differs only in which tools it may
touch, how many steps it gets, and what it is told to do. Adding a feature
means adding a spec, not another AI implementation.

  chat        conversation, tools when they help, web search allowed
  notebook    answers grounded in the sources the student ticked
  task        multi-step work: tools, Python, sub-agents, validation, mutations
  generation  quizzes, flashcards and other structured study material
  sub-agents  specialised, bounded, and answer to their parent
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from smolagents import ActionStep, CodeAgent, PlanningStep, ToolCallingAgent

from .model import HostModel
from .sandbox import SandboxExecutor
from .state import (
    EXECUTING, PLANNING, RETRIEVING, RunContext, VALIDATING, WAITING_SUBAGENT,
)
from .toolkit import Registry

# --------------------------------------------------------------------- prompts

SHARED = """You are Salem, the study assistant inside the student's own app.

How you work:
- Use your tools when they make the answer more accurate, more current or more
  specific to this student. Never describe a tool call you did not make, and
  never report an action as done unless the tool said it succeeded.
- When a tool fails, read the error, fix the call, and try a different route.
  If you cannot, say plainly what failed and what you did instead.
- Prefer computing over recalling: run Python for any real calculation.
- Never invent a date, a figure, a citation or a source. If something is
  ambiguous, say so and ask, rather than picking a plausible value.
- Write for a student: direct, warm, no filler. Maths in LaTeX ($…$ inline,
  $$…$$ displayed). Give the answer, then the reasoning that supports it —
  never a transcript of your own deliberation.
- The student sees which tools ran. They do not need the mechanics explained."""

CHAT = SHARED + """

You are in the main chat, so you can also act in the app: create notebooks,
write notes, make decks and quizzes, manage the calendar and the focus timer.
Act only on a clear request. Search the web whenever the answer depends on
something current, changing or checkable — prices, dates, releases, news,
anything you are less than sure of — and cite the pages you used."""

NOTEBOOK = SHARED + """

You are answering inside a notebook, and the student's own sources are what
count.

Retrieval is iterative, and you are not limited to what a search hands back.
Search, read what came back, and decide whether it actually answers the
question. If it does not:
- search again with the words the source itself would use;
- read the source directly with read_source, and keep calling it to page
  through the whole document if that is what it takes;
- look at their own notes with search_notes and read_note.

Running out of retrieved text is not the same as the material not covering it.
Go and get the rest before you say you cannot answer. Cite the excerpt number
in square brackets right after the sentence it supports.

If the sources genuinely do not cover something, say so and mark clearly which
part of your answer is general knowledge. Only use the web when the question
needs information the sources cannot hold, and say when you did."""

TASK = SHARED + """

This is a multi-step task, so work like an engineer rather than answering in
one breath:

1. Restate the objective and what "finished" will look like.
2. Look at what you actually have before planning around it.
3. Break the work into steps. Delegate self-contained parts to your sub-agents.
4. Use Python for anything structured — parsing, dates, tables, arithmetic
   over many rows. Do not do bulk data work in your head.
5. Check intermediate results as they come back. Retry the part that failed,
   not the whole task.
6. Validate before you apply anything to the student's app: dates parse, counts
   match, nothing is silently missing or duplicated.
7. Apply the changes, then verify the end state by reading it back.
8. Report what you did, and list anything left unresolved rather than guessing.

Keep the original extracted value next to any value you normalise, so a wrong
guess can be spotted."""

GENERATION = SHARED + """

You are generating study material. It has to be correct, because the student
will revise from it.

- Follow the requested schema exactly. No extra keys, no missing keys.
- Ground every item in the material you were given. If you were given sources,
  do not go outside them and do not search the web.
- Break content into atomic facts; one idea per card or question.
- Distractors must be plausible and from the same domain as the answer.
- Verify anything calculated with Python before you write it down.
- Hints must help the student reason or recall. A hint that gives the answer
  away, or that names the correct option, is a defect."""

SUBAGENTS: dict[str, dict] = {
    "pdf_extractor": {
        "description": "Extracts text, tables and page structure out of a PDF or a set of pages. Give it the source id or file name and what you need from it; it returns the extracted content with page numbers, in document order, and says which pages it could not read.",
        "instructions": "Extract exactly what was asked for. Keep page numbers and document order. Render pages and use OCR or vision only when normal text extraction returns nothing usable. Report missing, duplicated or malformed pages instead of skipping them quietly. Never fill a gap with plausible text.",
        "scopes": ["python", "sources", "vision"],
        "cls": "code",
        "steps": 10,
    },
    "date_checker": {
        "description": "Normalises and checks dates and schedule entries. Give it the extracted entries together with the text they came from; it returns each entry with a normalised date, the original wording, and a flag for anything ambiguous or conflicting.",
        "instructions": "Parse every date with Python, never by eye. Keep the original wording beside the normalised value. Flag anything ambiguous (day/month order, a missing year, two entries for the same slot) as unresolved rather than choosing. Check weekday names against the dates you produce and report the mismatches.",
        "scopes": ["python"],
        "cls": "code",
        "steps": 10,
    },
    "source_finder": {
        "description": "Searches the student's sources and comes back with the passages that actually answer a question, with their provenance. Give it the question and the source ids it may read.",
        "instructions": "Search, read what you get, judge whether it answers the question, and refine the search if it does not. Return the passages with their source title and page or slide, and say plainly when the sources do not cover something.",
        "scopes": ["sources", "notes"],
        "cls": "tool",
        "steps": 8,
    },
    "data_cruncher": {
        "description": "Processes structured data with Python: parsing, normalising, joining, aggregating, checking. Give it the data and the transformation you want; it returns the result and how it checked it.",
        "instructions": "Do the work in Python and print the result. Check your own output: row counts, totals, that nothing was dropped. Report the check alongside the result.",
        "scopes": ["python"],
        "cls": "code",
        "steps": 12,
    },
    "schedule_checker": {
        "description": "Verifies a proposed schedule before or after it is applied: duplicates, collisions, dates that fall on the wrong weekday, entries outside the term, items that went missing.",
        "instructions": "Check the proposed schedule against the source it came from, with Python. List every problem you find with the entry it belongs to. Say 'no problems found' only when you have actually checked each entry.",
        "scopes": ["python", "schedule"],
        "cls": "code",
        "steps": 10,
    },
    "quiz_checker": {
        "description": "Checks generated quiz questions: that the marked answer is right, that distractors are wrong but plausible, that hints do not give the answer away, and that anything calculated actually computes.",
        "instructions": "Work through every question. Recompute anything numeric in Python. Report each defect with the question index and what is wrong, and return the list of indices that need regenerating.",
        "scopes": ["python"],
        "cls": "code",
        "steps": 10,
    },
    "card_checker": {
        "description": "Checks generated flashcards: one fact per card, the back actually answers the front, nothing is duplicated, and every card is supported by the material.",
        "instructions": "Work through every card. Report each defect with the card index and what is wrong, and return the list of indices that need regenerating.",
        "scopes": ["python"],
        "cls": "code",
        "steps": 8,
    },
}


@dataclass
class AgentSpec:
    kind: str
    instructions: str
    scopes: list[str]
    read_only: bool = False
    steps: int = 12
    planning_interval: int | None = None
    code: bool = False
    subagents: list[str] = field(default_factory=list)
    allow: list[str] | None = None
    deny: list[str] = field(default_factory=list)


AGENTS: dict[str, AgentSpec] = {
    "chat": AgentSpec(
        kind="chat", instructions=CHAT,
        scopes=["study", "schedule", "notebooks", "sources", "notes", "cards", "quizzes",
                "search", "web", "python", "memory", "ui", "settings"],
        steps=10,
    ),
    "notebook": AgentSpec(
        kind="notebook", instructions=NOTEBOOK,
        scopes=["sources", "notes", "quizzes", "cards", "search", "python", "web"],
        read_only=True, steps=10,
    ),
    "task": AgentSpec(
        kind="task", instructions=TASK,
        scopes=["study", "schedule", "notebooks", "sources", "notes", "cards", "quizzes",
                "search", "web", "python", "files", "vision", "memory", "settings"],
        steps=20, planning_interval=4,
        subagents=["pdf_extractor", "date_checker", "source_finder", "data_cruncher",
                   "schedule_checker"],
    ),
    "generation": AgentSpec(
        kind="generation", instructions=GENERATION,
        scopes=["sources", "notes", "search", "python"],
        read_only=True, steps=12,
        subagents=["quiz_checker", "card_checker", "source_finder"],
    ),
}


# ----------------------------------------------------------------- building


def build(kind: str, ctx: RunContext, registry: Registry, model_id: str, *,
          thinking: bool = False, extra_instructions: str = "",
          files: list[int] | None = None, sources: list[int] | None = None,
          allow: list[str] | None = None, python_timeout: float = 60.0,
          subagents: list[str] | None = None) -> Any:
    """An agent of `kind`, wired to this run."""
    spec = AGENTS.get(kind)
    if spec is None:
        raise ValueError(f"unknown agent {kind!r}")
    model = HostModel(ctx, model_id, thinking=thinking)
    tools = registry.select(
        ctx,
        allow=allow if allow is not None else spec.allow,
        deny=spec.deny,
        scopes=spec.scopes,
        read_only=spec.read_only,
    )
    # A caller may narrow the delegation it is willing to pay for. Each
    # sub-agent is a nested agent loop with its own steps and its own context,
    # so one that is offered and taken is seconds, not milliseconds; a quiz of
    # definitions has nothing for the checker to recompute.
    offered = spec.subagents if subagents is None else [n for n in spec.subagents if n in subagents]
    managed = [
        _subagent(name, ctx, registry, model_id, files=files, sources=sources,
                  python_timeout=python_timeout)
        for name in offered
        if ctx.depth < ctx.budget.subagent_depth
    ]
    instructions = spec.instructions + (f"\n\n{extra_instructions}" if extra_instructions else "")
    agent = ToolCallingAgent(
        tools=tools,
        model=model,
        managed_agents=managed,
        instructions=instructions,
        max_steps=min(spec.steps, ctx.budget.steps),
        planning_interval=spec.planning_interval,
        verbosity_level=0,
        step_callbacks=[_progress(ctx)],
        return_full_result=True,
    )
    agent.salem_model = model
    return agent


def _subagent(name: str, ctx: RunContext, registry: Registry, model_id: str, *,
              files: list[int] | None, sources: list[int] | None,
              python_timeout: float) -> Any:
    """A specialised agent the parent can delegate to.

    It shares the parent's budgets and stop switch, one level deeper, so a
    delegation cannot outlive or outspend the task that started it.
    """
    conf = SUBAGENTS[name]
    child = ctx.child()
    model = HostModel(child, model_id, effort="low")
    tools = registry.select(child, scopes=list(conf["scopes"]), read_only=True)
    steps = min(int(conf["steps"]), max(2, ctx.budget.steps))
    common = dict(
        tools=tools,
        model=model,
        instructions=SHARED + "\n\n" + conf["instructions"] +
        "\n\nYou are a sub-agent: answer the task you were given, in full, as structured data "
        "where that is possible, and hand back what you could not do rather than papering over it.",
        max_steps=steps,
        verbosity_level=0,
        name=name,
        description=conf["description"],
        step_callbacks=[_progress(child, subagent=name)],
        provide_run_summary=False,
    )
    if conf["cls"] == "code":
        agent = CodeAgent(
            executor=SandboxExecutor(child, files=files, sources=sources, timeout=python_timeout),
            additional_authorized_imports=["*"],
            **common,
        )
    else:
        agent = ToolCallingAgent(**common)
    agent.salem_model = model
    agent.salem_context = child
    _meter(agent, ctx, child, name)
    return agent


def _meter(agent: Any, parent: RunContext, child: RunContext, name: str) -> None:
    """Count and announce a delegation, and refuse one that would breach the
    sub-agent limits. smolagents calls a managed agent like a tool, so this is
    the one place both the budget and the UI state can be applied."""
    base = type(agent)
    inner = base.__call__
    pretty = name.replace("_", " ")

    def call(self, task: str, **kwargs: Any):
        parent.spend_subagent()
        parent.state(WAITING_SUBAGENT, f"Asking the {pretty}")
        parent.emit({"kind": "subagent", "name": name, "status": "running",
                     "label": f"Asking the {pretty}", "task": str(task)[:400]})
        try:
            result = inner(self, task, **kwargs)
        except Exception as exc:
            parent.emit({"kind": "subagent", "name": name, "status": "error",
                         "label": f"The {pretty} could not finish", "detail": str(exc)[:400]})
            parent.state(EXECUTING)
            raise
        parent.emit({"kind": "subagent", "name": name, "status": "ok",
                     "label": f"The {pretty} reported back"})
        parent.state(EXECUTING)
        return result

    # Python resolves dunder methods on the type, so metering has to go on a
    # throwaway subclass rather than on the instance.
    agent.__class__ = type(f"Metered{base.__name__}", (base,), {"__call__": call})


def _progress(ctx: RunContext, subagent: str = "") -> Callable:
    """Turn each finished step into an execution state for the UI, and stop the
    run the moment a budget or the student says so."""

    def callback(step: Any, agent: Any = None) -> None:
        if isinstance(step, PlanningStep):
            ctx.state(PLANNING, f"{subagent} is planning" if subagent else "Planning")
            return
        if not isinstance(step, ActionStep):
            return
        ctx.spend.steps += 1
        usage = getattr(step, "token_usage", None)
        if usage is not None:
            ctx.charge_tokens(getattr(usage, "input_tokens", 0), getattr(usage, "output_tokens", 0))
        ctx.emit({
            "kind": "step",
            "n": ctx.spend.steps,
            "agent": subagent or "main",
            "tokens": ctx.spend.input_tokens + ctx.spend.output_tokens,
        })
        if getattr(step, "error", None):
            ctx.spend.retries += 1
            ctx.state(EXECUTING, "Recovering from a failed step")
        ctx.check()
        if agent is not None and ctx.cancelled:
            agent.interrupt()

    return callback


