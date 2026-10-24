"""In-process event bus (SSE), trade board and Gateway calls log."""
from __future__ import annotations

import asyncio
import json
from collections import OrderedDict, deque

from .contract import BoardEvent, GatewayCall


class EventBus:
    def __init__(self):
        self._subs: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        self._subs.discard(q)

    def publish(self, event: str, data: dict):
        msg = f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"
        for q in list(self._subs):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                self._subs.discard(q)  # slow client; it will reconnect


class Board:
    """Latest state per intent; updates replace earlier entries."""

    def __init__(self, bus: EventBus, maxlen: int = 100):
        self.bus = bus
        self.maxlen = maxlen
        self._events: OrderedDict[str, BoardEvent] = OrderedDict()

    def upsert(self, ev: BoardEvent):
        self._events[ev.intent_id] = ev
        self._events.move_to_end(ev.intent_id)
        while len(self._events) > self.maxlen:
            self._events.popitem(last=False)
        self.bus.publish("board", ev.model_dump(mode="json"))

    def recent(self, n: int = 50) -> list[BoardEvent]:
        return list(reversed(list(self._events.values())))[:n]


class CallLog:
    def __init__(self, bus: EventBus, maxlen: int = 300):
        self.bus = bus
        self._calls: deque[GatewayCall] = deque(maxlen=maxlen)

    def add(self, call: GatewayCall):
        self._calls.append(call)
        self.bus.publish("call", call.model_dump(mode="json"))

    def recent(self, n: int = 100) -> list[GatewayCall]:
        return list(reversed(self._calls))[:n]
