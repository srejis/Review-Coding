"""Public ChatGPT-plan model discovery and streaming Responses transport."""
import json
import re

import httpx

from chatgpt_auth import RESOURCE, ServiceError

DEFAULT_MODEL = "gpt-6-luna"
DEFAULT_EFFORT = "medium"
EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra")


def provider_error(body, status=None):
    if isinstance(body, dict):
        detail = body.get("error") or body
        code = detail.get("code") if isinstance(detail, dict) else detail
        if isinstance(code, str) and re.fullmatch(r"[a-zA-Z0-9_]{1,90}", code):
            return ServiceError(code, f"OpenAI request failed ({code}).")
    return ServiceError("provider_error", f"OpenAI request failed (HTTP {status or 'stream'}).")


class Responses:
    def __init__(self, access_token, transport=None, *, refresh=None):
        self.refresh = refresh
        self.client = httpx.AsyncClient(base_url=RESOURCE, transport=transport,
                                        headers={"Authorization": f"Bearer {access_token}"}, trust_env=transport is None,
                                        timeout=httpx.Timeout(55, connect=15))

    async def refresh_session(self):
        if self.refresh:
            self.client.headers["Authorization"] = f"Bearer {await self.refresh()}"

    async def models(self):
        await self.refresh_session()
        response = await self.client.get("models")
        if not response.is_success:
            try:
                body = response.json()
            except ValueError:
                body = {}
            raise provider_error(body, response.status_code)
        return [dict(id=row["slug"], name=row.get("display_name") or row["slug"],
                     efforts=row.get("supported_reasoning_efforts"))
                for row in response.json()["models"] if row.get("visibility") == "list"]

    async def generate(self, model, effort, instructions, messages, tools):
        await self.refresh_session()
        payload = dict(model=model, reasoning={"effort": effort}, instructions=instructions,
                       input=messages, tools=tools, tool_choice="required",
                       parallel_tool_calls=False, store=False, stream=True,
                       include=["reasoning.encrypted_content"])
        async with self.client.stream("POST", "responses", json=payload) as response:
            if not response.is_success:
                try:
                    body = json.loads(await response.aread())
                except ValueError:
                    body = {}
                raise provider_error(body, response.status_code)
            parts = []
            async for line in response.aiter_lines():
                if line:
                    if line.startswith("data:"):
                        parts.append(line[5:].lstrip())
                    continue
                if not parts:
                    continue
                raw, parts = "\n".join(parts), []
                if raw == "[DONE]":
                    break
                event = json.loads(raw)
                match event.get("type"):
                    case "response.completed":
                        return event["response"]
                    case "response.failed":
                        raise provider_error(event["response"])
                    case "error":
                        raise provider_error(event)
                    case "response.incomplete":
                        raise ServiceError("incomplete", "OpenAI ended the response before completion.")
        raise ServiceError("stream_interrupted", "Responses stream ended without a completed event.")
