"""Match model quotas without merging independently limited groups."""
import re


def family(model):
    model = str(model or "").lower()
    if model.startswith("gemini"):
        return "gemini"
    if model.startswith(("claude", "gpt")):
        return "claude_gpt"
    return None


def describe(name, description):
    """A pool counts when it lists its models (or is named "... models"); one that doesn't (a single model's own
    quota) has no family and is not tracked."""
    listed = re.search(r"models within this group:\s*(.+)", description, re.IGNORECASE)
    text = (listed.group(1) if listed else name if name.lower().endswith("models") else "").lower()
    kind = "claude_gpt" if "claude" in text or "gpt" in text else "gemini" if "gemini" in text else None
    patterns = {"gemini": ["gemini-*"], "claude_gpt": ["claude-*", "gpt-*"]}
    return {"name": name, "description": description, "family": kind, "model_patterns": patterns.get(kind, [])}


def group_id(name):
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def window(source, model):
    matches = [g for g in (source.get("groups") or {}).values()
               if family(model) is not None and g.get("family") == family(model)]
    if len(matches) != 1:
        return {}
    keys = matches[0].get("windows") or {}
    key = keys.get("5h") or keys.get("weekly")
    return next((w for w in source.get("windows") or [] if w.get("key") == key), {})
