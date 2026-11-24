"""Transport observations must not allow indefinitely growing malformed calls."""
import asyncio
import gzip
import json
from pathlib import Path
import tempfile
import unittest

import httpx
from baseline import ObservedStream
from chatgpt_auth import ServiceError


class FixtureStream(httpx.AsyncByteStream):
    def __init__(self, events):
        self.events = events
        self.closed = False

    async def __aiter__(self):
        for event in self.events:
            yield ("data: "+json.dumps(event)+"\n\n").encode()

    async def aclose(self):
        self.closed = True


class StreamGuardTests(unittest.IsolatedAsyncioTestCase):
    async def capture(self, events, expected=None):
        with tempfile.TemporaryDirectory() as tmp:
            inner = FixtureStream(events)
            stream = ObservedStream(inner, Path(tmp), 1, 200)
            try:
                if expected:
                    with self.assertRaises(ServiceError) as error:
                        async for _ in stream:
                            pass
                    self.assertEqual(error.exception.code, expected)
                else:
                    async for _ in stream:
                        pass
            finally:
                await stream.aclose()
            self.assertTrue(inner.closed)
            state = json.loads((Path(tmp)/"000001-stream-progress.json").read_text())
            if expected:
                self.assertEqual(state["aborted"], expected)
            else:
                self.assertEqual(state["last_event_type"], "response.completed")
            with gzip.open(Path(tmp)/"000001-stream.sse.gz", "rb") as file:
                self.assertIn(b"data:", file.read())

    async def test_normal_stream_is_preserved(self):
        await self.capture([
            dict(type="response.function_call_arguments.delta",item_id="a",delta='{"name":"value"}'),
            dict(type="response.completed")])

    async def test_argument_size_guard_is_per_call(self):
        await self.capture([
            dict(type="response.function_call_arguments.delta",item_id="a",delta="x"*60000),
            dict(type="response.function_call_arguments.delta",item_id="b",delta="y"*60000),
            dict(type="response.completed")])
        await self.capture([
            dict(type="response.function_call_arguments.delta",item_id="a",delta="x"*60000),
            dict(type="response.function_call_arguments.delta",item_id="a",delta="x"*40001)],
            "stream_arguments_limit")

    async def test_whitespace_loop_is_detected_across_chunks(self):
        await self.capture([
            dict(type="response.function_call_arguments.delta",item_id="a",delta=" "*5000),
            dict(type="response.function_call_arguments.delta",item_id="a",delta="x"),
            dict(type="response.function_call_arguments.delta",item_id="a",delta=" "*5000),
            dict(type="response.completed")])
        await self.capture([
            dict(type="response.function_call_arguments.delta",item_id="a",delta=" "*5000),
            dict(type="response.function_call_arguments.delta",item_id="a",delta="\r\n"*1600)],
            "stream_whitespace_loop")
