"""The model smolagents talks to: a proxy back to the app.

The runtime holds no API key and opens no sockets. Every completion is a
`model.complete` call to the host, which already knows the base URL, the key,
the retry policy and where to book the token usage. That also means one place
records telemetry and one place can cancel a request mid-flight.
"""

from __future__ import annotations

from typing import Any, Generator

from smolagents import ChatMessage, Model, TokenUsage
from smolagents.models import ChatMessageToolCall, ChatMessageToolCallFunction, MessageRole

from .rpc import Cancelled, HostError
from .state import RunContext


class HostModel(Model):
    """A smolagents `Model` whose completions are served by the Rust host."""

    def __init__(self, ctx: RunContext, model_id: str, *, thinking: bool = False,
                 effort: str = "", **kwargs: Any) -> None:
        super().__init__(model_id=model_id, **kwargs)
        self.ctx = ctx
        self.thinking = thinking
        # "low", "high" or "max"; empty means "whatever the student set".
        # Sub-agents ask for "low" explicitly: their work is mechanical, and
        # reasoning at length about it only adds seconds.
        self.effort = effort
        # The last reply's private reasoning. It is kept only so the API can be
        # given it back with the tool call it led to (DeepSeek requires that);
        # it is never emitted to the UI.
        self.last_reasoning = ""
        # How many replies in a row came back as prose with no tool call. One
        # is ordinary — the model is thinking aloud, or it considers itself
        # finished; two in a row means it is not going to produce the shape
        # smolagents wants, and prose is all we are going to get.
        self._prose_streak = 0

    # ------------------------------------------------------------ completion

    def generate(
        self,
        messages: list[ChatMessage],
        stop_sequences: list[str] | None = None,
        response_format: dict[str, str] | None = None,
        tools_to_call_from: list[Any] | None = None,
        **kwargs: Any,
    ) -> ChatMessage:
        self.ctx.check()
        body = self._prepare_completion_kwargs(
            messages=messages,
            stop_sequences=stop_sequences,
            response_format=response_format,
            tools_to_call_from=tools_to_call_from,
            convert_images_to_image_urls=True,
            # Never "required". DeepSeek's models all reason before they
            # answer, and its API rejects a forced tool choice on a thinking
            # model outright ("Thinking mode does not support this
            # tool_choice") — a 400 on the very first step of every agent run,
            # which is every agentic feature in the app failing at once.
            # "auto" is what the endpoint supports; the agent's own prompt is
            # what asks for a tool, and `parse_tool_calls` below picks up the
            # case where the model answers in prose instead.
            tool_choice="auto" if tools_to_call_from else None,
            **kwargs,
        )
        reply = self._complete(body, stream=False)
        return self._to_message(reply)

    def stream(self, messages: list[Any], tools: list[Any] | None = None, *,
               stream_to_ui: bool = True, **kwargs: Any) -> ChatMessage:
        """The direct, non-agentic pass: the same host call, but the text is
        streamed to the UI as it arrives. Used for requests the router judged
        answerable without multi-step execution; if the model asks for a tool
        anyway, the caller escalates into a full agent."""
        self.ctx.check()
        body = self._prepare_completion_kwargs(
            messages=messages,
            tools_to_call_from=tools,
            convert_images_to_image_urls=True,
            tool_choice="auto" if tools else None,
            **kwargs,
        )
        reply = self._complete(body, stream=stream_to_ui)
        return self._to_message(reply)

    # ------------------------------------------------------------- recovery

    def parse_tool_calls(self, message: ChatMessage) -> ChatMessage:
        """Read a reply that carried no tool call.

        smolagents asks for this when the API returns prose where it expected
        a call. Since the tool choice cannot be forced (see `generate`), that
        now happens whenever the model writes instead of calling: sometimes
        mid-task ("let me check the next page"), sometimes because it has
        finished and simply wrote the answer out.

        The two cases read alike, so the first one is refused: smolagents
        turns that into an error observation asking for a proper call, and a
        model that had more to do carries on. A model that answers in prose
        twice running is not going to produce the shape being asked for, and
        its answer is taken as final rather than spending the rest of the
        run's steps asking again.
        """
        try:
            return super().parse_tool_calls(message)
        except Exception:
            pass
        text = message.content if isinstance(message.content, str) else ""
        text = text.strip()
        if not text:
            raise ValueError("the model returned neither a tool call nor an answer")
        if self._prose_streak < 2:
            raise ValueError(
                "that reply had no tool call in it. Call a tool, and call "
                "final_answer when you are done."
            )
        message.role = MessageRole.ASSISTANT
        message.tool_calls = [
            ChatMessageToolCall(
                id="call_final",
                type="function",
                function=ChatMessageToolCallFunction(name="final_answer", arguments={"answer": text}),
            )
        ]
        return message

    # ---------------------------------------------------------------- plumbing

    def _complete(self, body: dict, *, stream: bool) -> dict:
        args = {
            "model": self.model_id,
            "feature": self.ctx.feature,
            "thinking": self.thinking,
            "effort": self.effort,
            "stream": stream,
            "run": self.ctx.run_id,
            "timeout": max(10.0, self.ctx.remaining),
            **body,
        }
        try:
            reply = self.ctx.call("model.complete", args, timeout=max(30.0, self.ctx.remaining + 15))
        except HostError as exc:
            # A failed completion is a real, observable error — never a
            # fabricated answer. The agent above decides whether to retry.
            raise HostError(f"the model could not be reached: {exc}") from exc
        if not isinstance(reply, dict):
            raise HostError("the model returned nothing")
        if reply.get("cancelled"):
            raise Cancelled("stopped")
        usage = reply.get("usage") or {}
        self.ctx.charge_tokens(int(usage.get("promptTokens") or 0), int(usage.get("completionTokens") or 0))
        return reply

    def _to_message(self, reply: dict) -> ChatMessage:
        self.last_reasoning = str(reply.get("reasoning") or "")
        raw_calls = reply.get("toolCalls") or reply.get("tool_calls") or []
        calls: list[ChatMessageToolCall] = []
        for i, call in enumerate(raw_calls):
            fn = call.get("function") or {}
            name = str(fn.get("name") or "").strip()
            if not name:
                continue
            calls.append(
                ChatMessageToolCall(
                    id=str(call.get("id") or f"call_{i}"),
                    type=str(call.get("type") or "function"),
                    function=ChatMessageToolCallFunction(name=name, arguments=fn.get("arguments")),
                )
            )
        self._prose_streak = 0 if calls else self._prose_streak + 1
        usage = reply.get("usage") or {}
        return ChatMessage(
            role=MessageRole.ASSISTANT,
            content=str(reply.get("content") or ""),
            tool_calls=calls or None,
            raw=reply,
            token_usage=TokenUsage(
                input_tokens=int(usage.get("promptTokens") or 0),
                output_tokens=int(usage.get("completionTokens") or 0),
            ),
        )

    # smolagents serialises models for sub-agent bookkeeping; ours is bound to a
    # live run, so give it something harmless rather than the context.
    def to_dict(self) -> dict:
        return {"class": "HostModel", "data": {"model_id": self.model_id, "thinking": self.thinking,
                                               "effort": self.effort}}
