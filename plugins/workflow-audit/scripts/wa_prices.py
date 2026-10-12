"""Price lookup. Longest-prefix model match, fallback multipliers for unknown models."""
import json

KEYS = ("input", "output", "cache_read", "cache_write_5m", "cache_write_1h")


def _common_prefix(a, b):
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


class Prices:
    def __init__(self, data, path=""):
        self.path = path
        self.source = data.get("source")
        self.checked = data.get("checked")
        self.models = data.get("models") or {}
        self.fallback = data.get("fallback") or {}
        self.unknown = {}  # model -> request count, filled by rates()
        self._memo = {}

    @classmethod
    def load(cls, path):
        with open(path, encoding="utf8") as f:
            return cls(json.load(f), str(path))

    def rates(self, model, prompt_tokens=0):
        """USD per million tokens for a model id and request prompt size."""
        r = self._memo.get(model)
        if r is None:
            r = self._memo[model] = self._resolve(model or "unknown")
        if prompt_tokens > 100000 and r.get("over_100k"):
            return r["over_100k"]
        return r

    def _resolve(self, model):
        best = None
        for k in self.models:
            if model.startswith(k) and (best is None or len(k) > len(best)):
                best = k
        if best:
            return self.models[best]
        self.unknown[model] = 0
        return self._from_fallback(model)

    def _from_fallback(self, model):
        # No price for this model: take the input price of the closest listed id
        # (longest shared prefix, mean on ties), then apply the fallback multiples.
        scored = [(_common_prefix(model, k), self.models[k]["input"]) for k in self.models]
        top = max((s for s, _ in scored), default=0)
        ins = [p for s, p in scored if s == top] or [0.0]
        inp = sum(ins) / len(ins)
        fb = self.fallback
        return {
            "input": inp,
            "output": inp * fb.get("output", 5.0),
            "cache_read": inp * fb.get("cache_read", 0.1),
            "cache_write_5m": inp * fb.get("cache_write_5m", 1.25),
            "cache_write_1h": inp * fb.get("cache_write_1h", 2.0),
        }

    def count_unknown(self, model, n=1):
        if model in self.unknown:
            self.unknown[model] += n
