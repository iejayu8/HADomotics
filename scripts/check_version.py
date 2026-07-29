#!/usr/bin/env python3
"""Verify addon version is consistent across project files.

Source of truth: hadomotics/config.yaml → version: "X.Y.Z"
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read_config_version() -> str:
    text = (ROOT / "hadomotics" / "config.yaml").read_text(encoding="utf-8")
    m = re.search(r'^version:\s*["\']?([^"\'\s]+)["\']?', text, re.MULTILINE)
    if not m:
        raise SystemExit("ERROR: version not found in hadomotics/config.yaml")
    return m.group(1).strip()


def main() -> int:
    version = read_config_version()
    errors: list[str] = []

    build = (ROOT / "hadomotics" / "build.yaml").read_text(encoding="utf-8")
    if f'io.hass.version: "{version}"' not in build and f"io.hass.version: '{version}'" not in build:
        errors.append(
            f"hadomotics/build.yaml: expected io.hass.version: \"{version}\""
        )

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    if f"Latest addon version: {version}" not in readme:
        errors.append(
            f"README.md: expected 'Latest addon version: {version}'"
        )

    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    if not re.search(rf"^##\s+{re.escape(version)}\b", changelog, re.MULTILINE):
        errors.append(
            f"CHANGELOG.md: missing section '## {version}'"
        )

    if errors:
        print(f"Version consistency FAILED for {version}:\n")
        for e in errors:
            print(f"  - {e}")
        print(
            "\nFix: update all files to match hadomotics/config.yaml,"
            "or run: python scripts/bump_version.py --sync"
        )
        return 1

    print(f"OK — version {version} is consistent across config.yaml, build.yaml, README.md, CHANGELOG.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
