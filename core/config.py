"""Resolve config once; children inherit its absolute file path.
Config paths are relative to that file, manifest paths to their manifest; code location supplies no data defaults."""
from __future__ import annotations

import json
import os
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path

PICKER = Path(__file__).resolve().parents[1]
DEFAULT = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "picker" / "picker.toml"
ENV = "PICKER_CONFIG"


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Config:
    file: Path
    data: Path
    state: Path
    cache: Path
    agents: Path
    types: tuple
    research: Path
    downloads: Path | None
    band: Path | None
    plugins: tuple
    host: str
    port: int
    names: tuple = ()        # host names it also answers to besides 127.0.0.1, localhost and ::1 (a tailnet's)
    unrestricted_agents: bool = False


def read(path: Path) -> Config:
    """One config file, every path made absolute against it. ConfigError on anything wrong: a missing file, bad TOML,
    a missing key."""
    path = Path(path).expanduser().resolve()
    try:
        raw = tomllib.loads(path.read_text())
    except FileNotFoundError:
        raise ConfigError(f"no config at {path}") from None
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise ConfigError(f"{path}: {e}") from None
    at = lambda key: (path.parent / str(raw[key])).resolve()           # noqa: E731
    missing = [k for k in ("data", "state", "cache", "agents", "types", "research") if k not in raw]
    if missing:
        raise ConfigError(f"{path}: missing {', '.join(missing)}")
    server = raw.get("server") or {}
    unrestricted = raw.get("unrestricted_agents", False)
    if not isinstance(unrestricted, bool):
        raise ConfigError(f"{path}: unrestricted_agents is a boolean")
    if raw.get("band") is not None and not isinstance(raw["band"], str):
        raise ConfigError(f"{path}: band is a script's path")
    band = at("band") if raw.get("band") else None
    if not (isinstance(raw["types"], list) and all(isinstance(x, str) for x in raw["types"])):
        raise ConfigError(f"{path}: types is a list of manifests (picker-type.json)")
    types = tuple((path.parent / x).resolve() for x in raw["types"])
    plugins = raw.get("plugins") or []
    if not (isinstance(plugins, list) and all(isinstance(x, str) for x in plugins)):
        raise ConfigError(f"{path}: plugins is a list of modules")
    names = server.get("names") or []
    if not (isinstance(names, list) and all(isinstance(x, str) for x in names)):
        raise ConfigError(f"{path}: server.names is a list of host names")
    return Config(file=path, data=at("data"), state=at("state"), cache=at("cache"), agents=at("agents"), types=types,
                  research=at("research"), downloads=at("downloads") if raw.get("downloads") else None, band=band,
                  plugins=tuple((path.parent / x).resolve() for x in plugins),
                  host=str(server.get("host", "127.0.0.1")), port=int(server.get("port", 8080)),
                  names=tuple(x.lower() for x in names), unrestricted_agents=unrestricted)


_CFG: Config | None = None


def _use(cfg: Config) -> Config:
    global _CFG
    _CFG = cfg
    os.environ[ENV] = str(cfg.file)                    # the children resolve the same file
    return cfg


def get() -> Config:
    """This process's config, resolved at first use: PICKER_CONFIG, else the user's default (DEFAULT, followed to the
    file it links to: a config's paths are relative to where it really is), else ConfigError."""
    if _CFG is not None:
        return _CFG
    if os.environ.get(ENV):
        return _use(read(Path(os.environ[ENV])))
    if DEFAULT.is_file():
        return _use(read(DEFAULT.resolve()))
    raise ConfigError(f"no config: pass --config or set {ENV}")


# Manifest paths are relative to their manifest on disk and to research when served.
def _paths(entry: dict, fn) -> dict:
    out = dict(entry)
    for k in ("researcher", "program", "plugin", "cards"):
        if out.get(k):
            out[k] = fn(out[k])
    if out.get("outputs"):
        out["outputs"] = [fn(o) for o in out["outputs"]]
    if isinstance(out.get("sync"), dict) and out["sync"].get("cwd") is not None:
        out["sync"] = {**out["sync"], "cwd": fn(out["sync"]["cwd"])}
    return out


_READ: dict = {}            # (the config's manifests, their mtimes) -> what they served; re-read when one changes


def _read(cfg: Config) -> list[dict]:
    stamp = []
    for m in cfg.types:
        try:
            stamp.append(m.stat().st_mtime_ns)
        except OSError:
            stamp.append(None)
    key = (cfg.types, cfg.research, tuple(stamp))
    if key not in _READ:
        out = []
        for m in cfg.types:
            try:
                raw = json.loads(m.read_text())
            except (OSError, ValueError) as e:
                raise ConfigError(f"{m}: {e}") from None
            out.append(_paths(raw, lambda v, d=m.parent: os.path.relpath(os.path.normpath(d / v), cfg.research)))
        _READ.clear()
        _READ[key] = out
    return _READ[key]


def types(cfg: Config | None = None) -> list[dict]:
    """The types, in the config's order: each manifest read, its paths relative to `research` (a copy: the caller
    may change it). ConfigError naming the manifest when one can't be read. Read again when a manifest changes."""
    import copy
    return copy.deepcopy(_read(cfg or get()))


def manifests(cfg: Config | None = None) -> list[dict]:
    """Every manifest as `types()` serves it, READ-ONLY (not copied: the card stores ask it for every card)."""
    try:
        return _read(cfg or get())
    except ConfigError:
        return []


def manifest(type_: str, cfg: Config | None = None) -> dict:
    """Return a cached read-only manifest; {} means undeclared or unreadable.
    Callers must not mutate this hot-path shared object."""
    try:
        return next((t for t in _read(cfg or get()) if t.get("type") == type_), {})
    except ConfigError:
        return {}


def capability(type_: str, name: str, cfg: Config | None = None):
    """Return the declared capability or None; do not infer type behavior from stored cards."""
    return (manifest(type_, cfg).get("capabilities") or {}).get(name)


def expand(argv) -> list[str]:
    """Expand interpreter/package placeholders; bare executables are resolved through PATH downstream."""
    return [str(a).replace("{python}", sys.executable).replace("{picker}", str(PICKER)) for a in argv]


def require(argv: list[str]) -> Config:
    """Require an argument/environment config for startup, with no default fallback.
    Exit before path-bound imports when it is absent or invalid."""
    path = None
    for i, a in enumerate(argv):
        if a == "--config" and i + 1 < len(argv):
            path = argv[i + 1]
        elif a.startswith("--config="):
            path = a.split("=", 1)[1]
    path = path or os.environ.get(ENV)
    if not path:
        sys.exit(f"[picker] no config: start it with --config <picker.toml> (or {ENV}); see picker/core/config.py")
    try:
        return _use(read(Path(path)))
    except ConfigError as e:
        sys.exit(f"[picker] bad config: {e}")
