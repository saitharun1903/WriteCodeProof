"""Behaviour-diff harness for Python. Runs inside the sandbox.

    python behaviour.py <plan.json> <out.json>

Same plan and output format as behaviour.mjs. Calls run in this process;
a SIGALRM timer stops any call that runs longer than callTimeoutMs.
"""

import asyncio
import copy
import importlib
import inspect
import json
import math
import random
import signal
import sys
import time
from pathlib import Path

MAX_DEPTH = 8
MAX_ITEMS = 100
MAX_STRING = 2000
SAFE_INT = 2**53


class CallTimeout(BaseException):
    """Derives from BaseException so `except Exception` in user code can't swallow it."""


def encode(value, seen=None, depth=0):
    seen = seen if seen is not None else set()
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value if abs(value) < SAFE_INT else {"$int": str(value)}
    if isinstance(value, float):
        if math.isnan(value):
            return {"$number": "NaN"}
        if math.isinf(value):
            return {"$number": "Infinity" if value > 0 else "-Infinity"}
        if value == 0 and math.copysign(1, value) < 0:
            return {"$number": "-0"}
        return value
    if isinstance(value, str):
        return value if len(value) <= MAX_STRING else value[:MAX_STRING] + "…"
    if isinstance(value, (bytes, bytearray)):
        return {"$bytes": list(value[:MAX_ITEMS])}
    if id(value) in seen:
        return {"$circular": True}
    if depth >= MAX_DEPTH:
        return {"$truncated": True}
    seen.add(id(value))
    try:
        nxt = lambda v: encode(v, seen, depth + 1)  # noqa: E731
        if isinstance(value, list):
            return [nxt(v) for v in value[:MAX_ITEMS]]
        if isinstance(value, tuple):
            return {"$tuple": [nxt(v) for v in value[:MAX_ITEMS]]}
        if isinstance(value, (set, frozenset)):
            return {"$set": sorted((nxt(v) for v in list(value)[:MAX_ITEMS]), key=repr)}
        if isinstance(value, dict):
            items = sorted(value.items(), key=lambda kv: repr(kv[0]))[:MAX_ITEMS]
            return {str(k): nxt(v) for k, v in items}
        if isinstance(value, BaseException):
            return {"$error": type(value).__name__, "message": str(value)}
        if callable(value):
            return {"$function": getattr(value, "__name__", "anonymous")}
        out = {"$class": type(value).__name__}
        attrs = getattr(value, "__dict__", None)
        if isinstance(attrs, dict):
            for k in sorted(attrs)[:MAX_ITEMS]:
                out[k] = nxt(attrs[k])
        else:
            out["$repr"] = repr(value)[:MAX_STRING]
        return out
    finally:
        seen.discard(id(value))


def decode(value):
    if isinstance(value, list):
        return [decode(v) for v in value]
    if isinstance(value, dict):
        if isinstance(value.get("$number"), str):
            return float(value["$number"])
        return {k: decode(v) for k, v in value.items()}
    return value


def module_name(file: str) -> str:
    parts = list(Path(file).with_suffix("").parts)
    if parts and parts[0] == "src":
        parts = parts[1:]
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + "…"


def on_alarm(_signum, _frame):
    raise CallTimeout()


def main() -> None:
    plan_path, out_path = sys.argv[1], sys.argv[2]
    plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    limit = plan["maxMessageChars"]
    timeout_s = plan["callTimeoutMs"] / 1000

    random.seed(plan["seed"])
    frozen = time.mktime(time.strptime(plan["frozenTime"][:19], "%Y-%m-%dT%H:%M:%S"))
    time.time = lambda: frozen
    signal.signal(signal.SIGALRM, on_alarm)

    results = []
    for target in plan["targets"]:
        entry = {"id": target["id"], "loadError": None, "calls": []}
        results.append(entry)
        try:
            module = importlib.import_module(module_name(target["file"]))
            fn = getattr(module, target["exportName"])
            if not callable(fn):
                raise TypeError(f"{target['exportName']} is not callable")
        except BaseException as error:  # noqa: BLE001 - report anything that stops the import
            entry["loadError"] = clip(f"{type(error).__name__}: {error}", limit)
            entry["calls"] = [None] * len(target["inputs"])
            continue

        for raw in target["inputs"]:
            args = decode(copy.deepcopy(raw))
            signal.setitimer(signal.ITIMER_REAL, timeout_s)
            try:
                value = fn(*args)
                if inspect.isawaitable(value):
                    value = asyncio.run(value)
                outcome = {"returned": encode(value), "args": encode(args)}
            except CallTimeout:
                outcome = {"timeout": True}
            except BaseException as error:  # noqa: BLE001
                outcome = {"threw": {"type": type(error).__name__, "message": clip(str(error), limit)}}
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
            entry["calls"].append(outcome)

    Path(out_path).write_text(json.dumps({"results": results}), encoding="utf-8")


if __name__ == "__main__":
    main()
