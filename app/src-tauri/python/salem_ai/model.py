from __future__ import annotations

from typing import Any, Generator

from smolagents import ChatMessage, Model, TokenUsage
from smolagents.models import ChatMessageToolCall, ChatMessageToolCallFunction, MessageRole

from .rpc import Cancelled, HostError
from .state import RunContext


class HostModel(Model):
    def __init__(self, ctx: RunContext, model_id: str, *, thinking: bool = False,
                 effort: str = "", **kwargs: Any) -> None:
        super().__init__(model_id=model_id, **kwargs)
        self.ctx = ctx
        self.thinking = thinking
        self.effort = effort
        self.last_reasoning = ""
        self._prose_streak = 0

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
            tool_choice="auto" if tools_to_call_from else None,
            **kwargs,
        )
        reply = self._complete(body, stream=False)
        return self._to_message(reply)

    def stream(self, messages: list[Any], tools: list[Any] | None = None, *,
               stream_to_ui: bool = True, **kwargs: Any) -> ChatMessage:
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

    def parse_tool_calls(self, message: ChatMessage) -> ChatMessage:
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

    def to_dict(self) -> dict:
        return {"class": "HostModel", "data": {"model_id": self.model_id, "thinking": self.thinking,
                                               "effort": self.effort}}
