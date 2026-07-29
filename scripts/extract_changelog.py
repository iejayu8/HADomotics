#!/usr/bin/env python3
"""Extract a CHANGELOG.md section for a given version."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: extract_changelog.py X.Y.Z", file=sys.stderr)
        return 1
    version = sys.argv[1]
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    pattern = rf"^##\s+{re.escape(version)}\s*$\n(.*?)(?=^##\s+|\Z)"
    m = re.search(pattern, text, re.MULTILINE | re.DOTALL)
    if not m:
        print(f"Release {version}\n\nSee CHANGELOG.md for details.")
        return 0
    body = m.group(1).strip()
    print(f"## {version}\n\n{body}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
