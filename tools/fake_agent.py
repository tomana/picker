#!/usr/bin/env python3
"""No model or network: delegate non-probe briefs to the local fake agent."""
import re
import runpy
import sys
from pathlib import Path


def main() -> int:
    prompt = sys.argv[1] if len(sys.argv) > 1 else ""
    if prompt.startswith("This is a wiring check"):
        m = re.search(r"create the file (\S+) \(relative to your working directory\)", prompt)
        if m:
            p = Path(m.group(1))
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("READY\n")
        print("READY")
        return 0
    own = Path.cwd() / "fake_agent.py"
    if not own.is_file():
        print(f"the fake agent: {Path.cwd()} has no fake_agent.py to answer a brief with — choose another agent",
              file=sys.stderr)
        return 2
    sys.argv = [str(own), prompt]
    runpy.run_path(str(own), run_name="__main__")
    return 0


if __name__ == "__main__":
    sys.exit(main())
