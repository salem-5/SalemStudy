"""The Salem AI runtime, tested against a fake host but a real process.

Run with the environment that has smolagents in it:

    <venv>/bin/python -m unittest discover -s app/src-tauri/python/tests
"""

from __future__ import annotations

import json
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_host import FakeHost, calls, real_sandbox, says, writes_code  # noqa: E402

CALENDAR_TOOLS = [
    {"name": "list_events", "description": "List calendar events between two dates.",
     "scopes": ["schedule"], "label": "Checking the calendar",
     "inputs": {"frm": {"type": "string", "description": "YYYY-MM-DD"},
                "to": {"type": "string", "description": "YYYY-MM-DD"}}},
    {"name": "add_event", "description": "Add an event to the calendar.",
     "scopes": ["schedule"], "mutating": True, "label": "Adding an event",
     "inputs": {"title": {"type": "string", "description": "Title"},
                "date": {"type": "string", "description": "YYYY-MM-DD"}}},
]

SOURCE_TOOLS = [
    {"name": "search_notebook", "description": "Search the notebook's sources.",
     "scopes": ["sources", "search"], "label": "Searching the sources",
     "inputs": {"query": {"type": "string", "description": "What to look for"}}},
]

QUIZ_SCHEMA = {
    "type": "object", "required": ["title", "questions"],
    "properties": {
        "title": {"type": "string"},
        "questions": {
            "type": "array", "minItems": 2,
            "items": {"type": "object",
                      "required": ["prompt", "choices", "answer", "hint"],
                      "properties": {"prompt": {"type": "string"},
                                     "choices": {"type": "array", "items": {"type": "string"}},
                                     "answer": {"type": "integer"},
                                     "hint": {"type": "string"}}},
        },
    },
}


class RuntimeTest(unittest.TestCase):
    host: FakeHost | None = None

    def tearDown(self) -> None:
        if self.host is not None:
            self.host.close()
            self.host = None

    def make(self, replies, tools=None, sandbox=None) -> FakeHost:
        self.host = FakeHost(replies, tools=tools, sandbox=sandbox)
        self.assertTrue(self.host.hello and self.host.hello.get("ok"),
                        f"runtime did not start: {self.host.hello}")
        return self.host

    # ------------------------------------------------------------ the paths

    def test_conversation_goes_through_the_agent(self):
        """Chat is agentic by default: the assistant should be able to look
        things up before answering, not only recall."""
        host = self.make([calls("final_answer", {"answer": "Paris is the capital of France."}, "a1")])
        result = host.run({"agent": "chat", "model": "m", "system": "You are Salem.",
                           "tools": CALENDAR_TOOLS,
                           "messages": [{"role": "user", "content": "Capital of France?"}]})
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["result"]["path"], "agentic")
        self.assertEqual(result["result"]["text"], "Paris is the capital of France.")
        self.assertEqual(host.states()[-1], "completed")

    def test_the_direct_path_is_still_there_when_it_is_asked_for(self):
        """Reading an image or naming a chat has nothing to look up, and must
        not pay for an agent loop."""
        host = self.make([says("A diagram of the Krebs cycle.")])
        result = host.run({"agent": "chat", "model": "m", "system": "S", "tools": [], "mode": "direct",
                           "messages": [{"role": "user", "content": "Describe this image."}]})
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["path"], "direct")
        self.assertEqual(host.model_calls(), 1, "one call, no planning round trip")

    def test_a_direct_pass_that_wants_a_tool_escalates(self):
        seen = []
        host = self.make(
            [calls("list_events", {"frm": "2026-10-01", "to": "2026-10-31"}),
             calls("list_events", {"frm": "2026-10-01", "to": "2026-10-31"}, "a1"),
             calls("final_answer", {"answer": "Your Calculus midterm is on 2 October."}, "a2")],
            tools={"list_events": lambda a: seen.append(a) or [{"title": "Calc midterm"}]},
        )
        result = host.run({"agent": "chat", "model": "m", "system": "S", "tools": CALENDAR_TOOLS,
                           "mode": "direct",
                           "messages": [{"role": "user", "content": "What's on in October?"}]})
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["path"], "agentic")
        self.assertIn("2 October", result["result"]["text"])
        self.assertEqual(seen, [{"frm": "2026-10-01", "to": "2026-10-31"}])
        self.assertIn("waiting_tool", host.states())

    # -------------------------------------------------- the one-pass path

    def test_generated_data_can_come_back_in_one_pass(self):
        """Generation is handed its material in the prompt, so there is
        usually nothing to look up. A full agent loop re-sends that material
        on every step; one pass sends it once."""
        host = self.make([says(json.dumps({"title": "Planes", "questions": [
            {"prompt": "What is n·(r-r0)=0?", "choices": ["a", "b"], "answer": 0, "hint": "Think dot product."},
            {"prompt": "What is a normal vector?", "choices": ["a", "b"], "answer": 1, "hint": "Perpendicular."},
        ]}))])
        result = host.run({"agent": "generation", "model": "m", "system": "S", "tools": [],
                           "mode": "direct", "schema": QUIZ_SCHEMA,
                           "messages": [{"role": "user", "content": "Write 2 questions."}]})
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["result"]["path"], "direct")
        self.assertEqual(len(result["result"]["structured"]["questions"]), 2)
        self.assertEqual(host.model_calls(), 1)

    def test_a_one_pass_answer_that_does_not_fit_escalates_rather_than_returning(self):
        """The cheap path may be wrong. It may not hand back something wrong."""
        host = self.make([
            says("Here are some questions, roughly."),
            calls("final_answer", {"answer": {"title": "Planes", "questions": [
                {"prompt": "q1", "choices": ["a", "b"], "answer": 0, "hint": "h"},
                {"prompt": "q2", "choices": ["a", "b"], "answer": 1, "hint": "h"},
            ]}}, "a1"),
        ])
        result = host.run({"agent": "generation", "model": "m", "system": "S", "tools": [],
                           "mode": "direct", "schema": QUIZ_SCHEMA,
                           "messages": [{"role": "user", "content": "Write 2 questions."}]})
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["result"]["path"], "agentic")
        self.assertEqual(len(result["result"]["structured"]["questions"]), 2)

    # ------------------------------------------------------- awkward tools

    def test_a_tool_argument_named_like_a_python_keyword_still_works(self):
        """The app declares its tools in JSON, where `from` is an ordinary
        key. Here each one becomes a real function, and a parameter cannot be
        called `from`. That used to raise out of `select()` before the first
        step, so one awkward name in one tool was every agentic feature in the
        app failing at once."""
        seen: list[dict] = []
        host = self.make(
            [calls("read_source", {"from_": 3, "sourceId": 7}, "a1"),
             calls("final_answer", {"answer": "Page 3 covers the Golgi."}, "a2")],
            tools={"read_source": lambda a: seen.append(a) or [{"page": 3, "text": "The Golgi."}]},
        )
        result = host.run({
            "agent": "notebook", "model": "m", "system": "S",
            "tools": [{"name": "read_source", "description": "Read pages of a source.",
                       "scopes": ["sources"], "label": "Reading",
                       "inputs": {
                           "from": {"type": "integer", "description": "First page", "nullable": True},
                           "sourceId": {"type": "integer", "description": "The source"},
                       }}],
            "messages": [{"role": "user", "content": "What is on page 3?"}],
        })
        self.assertTrue(result["ok"], result.get("error"))
        # The app is handed back the name it declared, not the one Python needed.
        self.assertEqual(seen, [{"from": 3, "sourceId": 7}])

    def test_an_optional_argument_declared_first_does_not_break_the_tool(self):
        """A Python function cannot take a required argument after one with a
        default, so a tool whose optional input happens to come first used to
        end the run with "non-default argument follows default argument"."""
        seen: list[dict] = []
        host = self.make(
            [calls("read_source", {"sourceId": 7}, "a1"),
             calls("final_answer", {"answer": "Read it."}, "a2")],
            tools={"read_source": lambda a: seen.append(a) or [{"page": 1, "text": "Hello."}]},
        )
        result = host.run({
            "agent": "notebook", "model": "m", "system": "S",
            "tools": [{"name": "read_source", "description": "Read pages of a source.",
                       "scopes": ["sources"], "label": "Reading",
                       "inputs": {
                           "upTo": {"type": "integer", "description": "Last page", "nullable": True},
                           "sourceId": {"type": "integer", "description": "The source"},
                       }}],
            "messages": [{"role": "user", "content": "Read source 7."}],
        })
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(seen, [{"sourceId": 7}])

    def test_one_undeclarable_tool_does_not_take_the_run_with_it(self):
        host = self.make(
            [calls("search_notebook", {"query": "golgi"}, "a1"),
             calls("final_answer", {"answer": "It packages proteins [1]."}, "a2")],
            tools={"search_notebook": lambda a: [{"source": "Lecture 4", "text": "It packages proteins."}]},
        )
        broken = {"name": "not a tool name", "description": "Unusable.",
                  "scopes": ["sources"], "inputs": {}}
        result = host.run({
            "agent": "notebook", "model": "m", "system": "S",
            "tools": [*SOURCE_TOOLS, broken],
            "messages": [{"role": "user", "content": "What does the Golgi do?"}],
        })
        self.assertTrue(result["ok"], result.get("error"))

    # --------------------------------------------------------- what it costs

    def test_delegation_can_be_narrowed_by_the_caller(self):
        """Each sub-agent taken is a nested agent loop, so a caller that knows
        there is nothing to recompute can decline to pay for one."""
        # The task agent plans before it acts, so the plan comes first.
        host = self.make([says("I will answer directly."),
                          calls("final_answer", {"answer": "done"}, "a1")])
        result = host.run({
            "agent": "task", "model": "m", "system": "S", "tools": [],
            "subagents": ["source_finder"],
            "messages": [{"role": "user", "content": "Do the thing."}],
        })
        self.assertTrue(result["ok"], result.get("error"))
        offered = json.dumps([a.get("tools") for method, a in host.calls if method == "model.complete"])
        self.assertIn("source_finder", offered)
        self.assertNotIn("date_checker", offered)
        self.assertNotIn("pdf_extractor", offered)

    def test_a_subagent_reasons_as_little_as_the_work_needs(self):
        host = self.make([calls("final_answer", {"answer": "done"}, "a1")])
        host.run({"agent": "chat", "model": "m", "system": "S", "tools": [],
                  "messages": [{"role": "user", "content": "Hello."}]})
        sent = [a for method, a in host.calls if method == "model.complete"]
        # The main agent leaves it to the student's setting; the host fills in.
        self.assertEqual([a.get("effort") for a in sent], [""] * len(sent))

    # ----------------------------------------------------- the request shape

    def test_the_tool_choice_is_one_the_api_accepts(self):
        """DeepSeek reasons before it answers, and rejects a forced tool
        choice on a thinking model: `tool_choice: "required"` comes back as
        HTTP 400 on the very first step, which is every agentic feature in
        the app failing at once."""
        host = self.make(
            [calls("search_notebook", {"query": "golgi"}, "a1"),
             calls("final_answer", {"answer": "It packages proteins [1]."}, "a2")],
            tools={"search_notebook": lambda a: [{"source": "Lecture 4", "text": "It packages proteins."}]},
        )
        result = host.run({"agent": "notebook", "model": "m", "system": "S", "tools": SOURCE_TOOLS,
                           "messages": [{"role": "user", "content": "What does the Golgi do?"}]})
        self.assertTrue(result["ok"])
        sent = [args for method, args in host.calls if method == "model.complete"]
        self.assertTrue(sent, "the run never reached the model")
        self.assertNotIn("required", [a.get("tool_choice") for a in sent])
        with_tools = [a for a in sent if a.get("tools")]
        self.assertTrue(with_tools, "the agent was never offered its tools")
        for args in with_tools:
            self.assertEqual(args.get("tool_choice"), "auto")

    def test_an_answer_written_as_prose_is_asked_for_again_then_accepted(self):
        """Without a forced tool choice the model sometimes writes instead of
        calling. Mid-task prose ("let me check the next page") must not end
        the run, so the first one is refused; a model that does it twice
        running is not going to produce the shape being asked for, and its
        answer is taken rather than burning the remaining steps."""
        host = self.make([
            says("Let me look at the next page before I answer."),
            says("The Golgi packages proteins."),
        ])
        result = host.run({"agent": "chat", "model": "m", "system": "S", "tools": [],
                           "messages": [{"role": "user", "content": "What does the Golgi do?"}]})
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["result"]["text"], "The Golgi packages proteins.")
        self.assertEqual(host.model_calls(), 2)

    def test_prose_once_does_not_end_a_run_that_had_more_to_do(self):
        host = self.make(
            [says("Let me search the notebook first."),
             calls("search_notebook", {"query": "golgi"}, "a1"),
             calls("final_answer", {"answer": "It packages proteins [1]."}, "a2")],
            tools={"search_notebook": lambda a: [{"source": "Lecture 4", "text": "It packages proteins."}]},
        )
        result = host.run({"agent": "notebook", "model": "m", "system": "S", "tools": SOURCE_TOOLS,
                           "messages": [{"role": "user", "content": "What does the Golgi do?"}]})
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["text"], "It packages proteins [1].")
        self.assertEqual([e["name"] for e in host.of_kind("tool")][:1], ["search_notebook"])

    # ------------------------------------------------------------ the tools

    def test_a_tool_call_really_runs_and_its_result_reaches_the_agent(self):
        host = self.make(
            [calls("search_notebook", {"query": "golgi"}, "a1"),
             calls("final_answer", {"answer": "It packages proteins [1]."}, "a2")],
            tools={"search_notebook": lambda a: [{"source": "Lecture 4", "text": "The Golgi packages proteins."}]},
        )
        result = host.run({"agent": "notebook", "model": "m", "system": "S", "tools": SOURCE_TOOLS,
                           "messages": [{"role": "user", "content": "What does the Golgi do?"}]})
        self.assertTrue(result["ok"])
        statuses = [(e["name"], e["status"]) for e in host.of_kind("tool")]
        self.assertEqual(statuses, [("search_notebook", "running"), ("search_notebook", "ok")])

    def test_a_failing_tool_is_reported_and_the_agent_recovers(self):
        attempts = {"n": 0}

        def flaky(_args):
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise RuntimeError("the source index is rebuilding")
            return [{"source": "Lecture 4", "text": "The Golgi packages proteins."}]

        host = self.make(
            [calls("search_notebook", {"query": "golgi"}, "a1"),
             calls("search_notebook", {"query": "golgi apparatus"}, "a2"),
             calls("final_answer", {"answer": "It packages proteins [1]."}, "a3")],
            tools={"search_notebook": flaky},
        )
        result = host.run({"agent": "notebook", "model": "m", "system": "S", "tools": SOURCE_TOOLS,
                           "messages": [{"role": "user", "content": "What does the Golgi do?"}]})
        self.assertTrue(result["ok"])
        self.assertEqual(attempts["n"], 2)
        self.assertEqual([e["status"] for e in host.of_kind("tool")],
                         ["running", "error", "running", "ok"])
        self.assertEqual(result["result"]["telemetry"]["tool_failures"], 1)

    def test_a_read_only_agent_is_not_given_mutating_tools(self):
        host = self.make([says("The sources say the Golgi packages proteins.")])
        host.run({"agent": "notebook", "model": "m", "system": "S",
                  "tools": CALENDAR_TOOLS + SOURCE_TOOLS,
                  "messages": [{"role": "user", "content": "What does the Golgi do?"}]})
        offered = {t["function"]["name"]
                   for _, args in host.calls if _ == "model.complete"
                   for t in (args.get("tools") or [])}
        self.assertIn("search_notebook", offered)
        self.assertNotIn("add_event", offered)   # mutating
        self.assertNotIn("list_events", offered)  # out of scope for a notebook

    # -------------------------------------------------------------- Python

    def test_python_really_executes_and_state_carries_between_blocks(self):
        scripts = []

        def sandbox(code):
            scripts.append(code)
            return real_sandbox(code)

        host = self.make(
            [says("Plan: parse the dates, count the weeks, report."),
             calls("data_cruncher", {"task": "Count the whole weeks from 2026-09-01 to 2026-12-18"}, "p1"),
             writes_code("from datetime import date\n"
                         "start = date(2026, 9, 1)\nend = date(2026, 12, 18)\n"
                         "weeks = (end - start).days // 7\nprint('weeks', weeks)"),
             writes_code("final_answer({'weeks': weeks, 'days': (end - start).days})"),
             calls("final_answer", {"answer": "The term runs 15 whole weeks (108 days)."}, "p2")],
            sandbox=sandbox,
        )
        result = host.run({"agent": "task", "model": "m", "system": "S", "tools": [],
                           "messages": [{"role": "user", "content": "go through every week of the term"}]})
        self.assertTrue(result["ok"])
        self.assertIn("15 whole weeks", result["result"]["text"])
        # The first block really ran: its printed output came back.
        self.assertIn("weeks 15", host.of_kind("python")[0]["output"])
        # The second block used a name from the first, so the replay works.
        self.assertIn("redirect_stdout", scripts[1])
        self.assertEqual(result["result"]["telemetry"]["python_calls"], 2)

    def test_a_python_error_reaches_the_agent_rather_than_being_swallowed(self):
        host = self.make(
            [says("Plan."),
             calls("data_cruncher", {"task": "divide"}, "p1"),
             writes_code("print(1 / 0)"),
             writes_code("final_answer('cannot divide by zero')"),
             calls("final_answer", {"answer": "That division is undefined."}, "p2")],
            sandbox=real_sandbox,
        )
        result = host.run({"agent": "task", "model": "m", "system": "S", "tools": [],
                           "messages": [{"role": "user", "content": "for each row divide by zero"}]})
        self.assertTrue(result["ok"])
        failed = [e for e in host.of_kind("python") if e["status"] == "error"]
        self.assertTrue(failed, "the failing block should be reported as failed")
        self.assertIn("ZeroDivisionError", failed[0]["output"])
        self.assertEqual(result["result"]["telemetry"]["python_failures"], 1)

    # ---------------------------------------------------------- sub-agents

    def test_delegation_is_counted_announced_and_bounded(self):
        host = self.make(
            [says("Plan."),
             calls("data_cruncher", {"task": "count"}, "p1"),
             writes_code("final_answer({'n': 3})"),
             calls("final_answer", {"answer": "Three."}, "p2")],
            sandbox=real_sandbox,
        )
        result = host.run({"agent": "task", "model": "m", "system": "S", "tools": [],
                           "messages": [{"role": "user", "content": "go through every assignment"}]})
        self.assertTrue(result["ok"])
        self.assertEqual([(e["name"], e["status"]) for e in host.of_kind("subagent")],
                         [("data_cruncher", "running"), ("data_cruncher", "ok")])
        self.assertEqual(result["result"]["telemetry"]["subagents"], 1)
        self.assertIn("waiting_subagent", host.states())

    def test_the_subagent_budget_stops_runaway_delegation(self):
        replies = [says("Plan.")]
        for i in range(12):
            replies.append(calls("data_cruncher", {"task": f"chunk {i}"}, f"p{i}"))
            replies.append(writes_code(f"final_answer({i})"))
        replies.append(calls("final_answer", {"answer": "done"}, "pz"))
        host = self.make(replies, sandbox=real_sandbox)
        result = host.run({"agent": "task", "model": "m", "system": "S", "tools": [],
                           "budget": {"subagents": 2, "steps": 12},
                           "messages": [{"role": "user", "content": "go through every assignment one by one"}]})
        used = [e for e in host.of_kind("subagent") if e["status"] == "running"]
        self.assertLessEqual(len(used), 3, "delegation should stop at the budget")
        self.assertIsNotNone(result)

    # ---------------------------------------------------------- generation

    def test_generated_data_is_validated_and_the_bad_attempt_is_retried(self):
        good = {"title": "Derivatives", "questions": [
            {"prompt": "d/dx of x^3?", "choices": ["3x^2", "x^2", "3x"], "answer": 0,
             "hint": "Bring the exponent down and drop it by one."},
            {"prompt": "d/dx of sin x?", "choices": ["cos x", "-cos x", "sin x"], "answer": 0,
             "hint": "Think about the slope of the sine wave at zero."}]}
        bad = {"title": "Derivatives", "questions": [
            {"prompt": "d/dx of x^3?", "choices": ["3x^2"], "answer": 0, "hint": "h"}]}
        host = self.make([calls("final_answer", {"answer": bad}, "g1"),
                          calls("final_answer", {"answer": good}, "g2")])
        result = host.run({"agent": "generation", "model": "m", "system": "S", "tools": [],
                           "schema": QUIZ_SCHEMA,
                           "messages": [{"role": "user", "content": "two questions on derivatives"}]})
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["result"]["structured"]["questions"]), 2)
        self.assertEqual(result["result"]["telemetry"]["retries"], 1)
        self.assertIn("validating", host.states())

    def test_data_that_never_validates_fails_instead_of_being_returned(self):
        bad = {"title": "x", "questions": []}
        host = self.make([calls("final_answer", {"answer": bad}, f"g{i}") for i in range(6)])
        result = host.run({"agent": "generation", "model": "m", "system": "S", "tools": [],
                           "schema": QUIZ_SCHEMA,
                           "messages": [{"role": "user", "content": "two questions"}]})
        self.assertFalse(result["ok"])
        self.assertIn("schema", result["error"])

    # ------------------------------------------------- stopping and budgets

    def test_cancelling_stops_a_run_waiting_on_a_slow_tool(self):
        entered = threading.Event()

        def slow(_args):
            entered.set()
            time.sleep(30)
            return []

        host = self.make([calls("search_notebook", {"query": "x"}),
                          calls("search_notebook", {"query": "x"}, "a1"),
                          calls("final_answer", {"answer": "…"}, "a2")],
                         tools={"search_notebook": slow})
        host.start({"agent": "notebook", "model": "m", "system": "S", "tools": SOURCE_TOOLS,
                    "messages": [{"role": "user", "content": "anything"}]})
        self.assertTrue(entered.wait(20), "the tool should have been called")
        started = time.monotonic()
        host.cancel()
        result = host.wait(timeout=30)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "stopped")
        self.assertEqual(host.states()[-1], "cancelled")
        self.assertLess(time.monotonic() - started, 10, "cancelling must not wait out the tool")

    def test_a_run_that_overruns_its_time_fails_visibly(self):
        def slow_model(_args):
            time.sleep(1.5)
            return says("still going")

        host = self.make([slow_model for _ in range(20)],
                         tools={"search_notebook": lambda a: []})
        result = host.run({"agent": "task", "model": "m", "system": "S", "tools": SOURCE_TOOLS,
                           "budget": {"seconds": 2, "steps": 6},
                           "messages": [{"role": "user", "content": "go through every page one by one"}]},
                          timeout=60)
        self.assertFalse(result["ok"])
        self.assertIn("limit", result["error"])
        self.assertEqual(host.states()[-1], "failed")

    # ------------------------------------------------------ working memory

    def test_task_state_is_saved_and_picked_up_by_the_next_run(self):
        host = self.make([calls("final_answer", {"answer": "I have noted the deadline."}, "a1"),
                          calls("final_answer", {"answer": "It is due on 12 December."}, "a2")])
        host.run({"agent": "chat", "model": "m", "system": "S", "tools": [], "taskId": "t-1",
                  "messages": [{"role": "user", "content": "My essay is due 12 December."}]})
        self.assertIn("t-1", host.saved)
        self.assertIn("12 December", host.saved["t-1"]["objective"])

        host.run({"agent": "chat", "model": "m", "system": "S", "tools": [], "taskId": "t-1",
                  "messages": [{"role": "user", "content": "When is it due again?"}]}, run="r2")
        # The second run was given the state, not asked to rediscover it.
        # The agent puts it in the task it is handed, not the system prompt,
        # because that is where smolagents keeps what the run is about.
        last = [args for method, args in host.calls if method == "model.complete"][-1]
        sent = json.dumps(last["messages"])
        self.assertIn("Objective:", sent)
        self.assertIn("12 December", sent)

    def test_compaction_keeps_the_objective_and_the_recent_turns(self):
        filler = "x " * 4000
        history: list[dict] = []
        for i in range(12):
            history.append({"role": "user", "content": f"Message {i}: {filler}"})
            history.append({"role": "assistant", "content": f"Noted, {i}."})
        history.append({"role": "user", "content": "So what was my deadline?"})
        host = self.make([
            # Compaction is a direct call of its own, whatever the run's path.
            says('{"summary": "The student set up a revision plan.",'
                 ' "dates": {"essay deadline": "12 December"},'
                 ' "constraints": ["no study after 9pm"]}'),
            calls("final_answer", {"answer": "Your essay is due on 12 December."}, "a1"),
        ])
        result = host.run({"agent": "chat", "model": "m", "system": "S", "tools": [], "taskId": "t-2",
                           "objective": "Plan my revision", "messages": history})
        self.assertTrue(result["ok"])
        memory = result["result"]["memory"]
        self.assertEqual(memory["objective"], "Plan my revision")
        self.assertEqual(memory["dates"]["essay deadline"], "12 December")
        self.assertIn("no study after 9pm", memory["constraints"])
        sent = [args for method, args in host.calls if method == "model.complete"][-1]["messages"]
        self.assertLess(len(sent), len(history), "older turns should have been folded away")
        self.assertIn("So what was my deadline?",
                      str(sent[-1]["content"]), "the newest turn must survive compaction")

    # ------------------------------------------------------------ fallback

    def test_the_runtime_degrades_rather_than_hanging_when_tools_keep_failing(self):
        host = self.make(
            [calls("search_notebook", {"query": "x"})] +
            [calls("search_notebook", {"query": "x"}, f"a{i}") for i in range(40)] +
            [says("I could not reach your sources, so this is from general knowledge.")],
            tools={"search_notebook": lambda a: (_ for _ in ()).throw(RuntimeError("index is gone"))},
        )
        result = host.run({"agent": "notebook", "model": "m", "system": "S", "tools": SOURCE_TOOLS,
                           "budget": {"steps": 3},
                           "messages": [{"role": "user", "content": "What does the Golgi do?"}]},
                          timeout=120)
        self.assertIsNotNone(result)
        self.assertIn(host.states()[-1], {"completed", "failed"})
        if result["ok"]:
            self.assertTrue(result["result"].get("degraded"))


class ContractTest(unittest.TestCase):
    """The tool declarations the app sends are exactly what `lib/salem/tools.ts`
    produces. If these drift, tools silently stop being offered to the model."""

    host: FakeHost | None = None

    def tearDown(self) -> None:
        if self.host is not None:
            self.host.close()
            self.host = None

    def test_a_typescript_tool_declaration_becomes_a_usable_tool(self):
        # Copied from the shape `toSpec()` emits: camelCase outputType,
        # nullable optionals, enums, and array items.
        declared = [{
            "name": "add_event",
            "description": "Add an event to the study calendar.",
            "inputs": {
                "title": {"type": "string", "description": "Title"},
                "date": {"type": "string", "description": "YYYY-MM-DD"},
                "time": {"type": "string", "description": "HH:MM", "nullable": True},
                "kind": {"type": "string", "description": "Kind", "nullable": True,
                         "enum": ["exam", "deadline", "study", "class", "other"]},
                "tags": {"type": "array", "description": "Tags", "nullable": True,
                         "items": {"type": "string"}},
            },
            "outputType": "object",
            "mutating": True,
            "scopes": ["schedule"],
            "label": "Adding an event",
            "timeout": 90,
        }]
        got: list[dict] = []
        self.host = FakeHost(
            [calls("add_event", {"title": "Calc midterm", "date": "2026-10-02"}, "a1"),
             calls("final_answer", {"answer": "Added it for 2 October."}, "a2")],
            tools={"add_event": lambda a: got.append(a) or {"ok": True, "label": "Added Calc midterm", "id": 7}},
        )
        result = self.host.run({"agent": "chat", "model": "m", "system": "S", "tools": declared,
                                "messages": [{"role": "user", "content": "add my calc midterm on 2 October"}]})
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(got, [{"title": "Calc midterm", "date": "2026-10-02"}])

        # The schema that reached the model keeps the optionals optional.
        offered = [t for _, args in self.host.calls if _ == "model.complete"
                   for t in (args.get("tools") or []) if t["function"]["name"] == "add_event"][0]
        self.assertEqual(sorted(offered["function"]["parameters"]["required"]), ["date", "title"])
        self.assertEqual(offered["function"]["parameters"]["properties"]["kind"]["enum"],
                         ["exam", "deadline", "study", "class", "other"])

    def test_a_mutating_tool_carries_an_idempotency_key(self):
        declared = [{"name": "add_event", "description": "Add an event.", "mutating": True,
                     "scopes": ["schedule"], "inputs": {"title": {"type": "string", "description": "t"}}}]
        keys: list[object] = []
        self.host = FakeHost(
            [calls("add_event", {"title": "x"}), calls("add_event", {"title": "x"}, "a1"),
             calls("final_answer", {"answer": "done"}, "a2")],
            tools={"add_event": lambda a: {"ok": True}},
        )
        self.host.run({"agent": "chat", "model": "m", "system": "S", "tools": declared,
                       "messages": [{"role": "user", "content": "add x"}]})
        for method, args in self.host.calls:
            if method == "tool.invoke":
                keys.append(args.get("idem"))
        self.assertTrue(keys and all(isinstance(k, str) and k for k in keys),
                        "a mutating call must carry a key the app can deduplicate on")

    def test_a_read_only_tool_carries_no_key(self):
        declared = [{"name": "list_events", "description": "List events.", "scopes": ["schedule"],
                     "inputs": {"frm": {"type": "string", "description": "d"}}}]
        self.host = FakeHost(
            [calls("list_events", {"frm": "2026-01-01"}), calls("list_events", {"frm": "2026-01-01"}, "a1"),
             calls("final_answer", {"answer": "none"}, "a2")],
            tools={"list_events": lambda a: []},
        )
        self.host.run({"agent": "chat", "model": "m", "system": "S", "tools": declared,
                       "messages": [{"role": "user", "content": "what is on"}]})
        idem = [args.get("idem") for method, args in self.host.calls if method == "tool.invoke"]
        self.assertTrue(all(k is None for k in idem))

    def test_the_python_tool_is_metered_against_the_python_budget(self):
        declared = [{"name": "run_python", "description": "Run Python.", "scopes": ["python"],
                     "state": "running_python", "inputs": {"code": {"type": "string", "description": "code"}}}]
        self.host = FakeHost(
            [calls("run_python", {"code": "print(1)"})] +
            [calls("run_python", {"code": "print(1)"}, f"a{i}") for i in range(10)],
            tools={"run_python": lambda a: {"ok": True, "stdout": "1\n"}},
        )
        result = self.host.run({"agent": "chat", "model": "m", "system": "S", "tools": declared,
                                "budget": {"pythonCalls": 2, "steps": 8},
                                "messages": [{"role": "user", "content": "compute"}]})
        self.assertIsNotNone(result)
        ran = sum(1 for method, args in self.host.calls
                  if method == "tool.invoke" and args["name"] == "run_python")
        self.assertLessEqual(ran, 3, "the Python budget should stop the run")


if __name__ == "__main__":
    unittest.main(verbosity=2)
