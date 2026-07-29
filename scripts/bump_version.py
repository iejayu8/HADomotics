#!/usr/bin/env python3
"""Bump or sync the HADomotics addon version.

Source of truth: hadomotics/config.yaml

Usage:
  python scripts/bump_version.py patch|minor|major
  python scripts/bump_version.py --set 3.1.0
  python scripts/bump_version.py --sync          # propagate current config.yaml version
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "hadomotics" / "config.yaml"
BUILD = ROOT / "hadomotics" / "build.yaml"
README = ROOT / "README.md"
CHANGELOG = ROOT / "CHANGELOG.md"


def get_version() -> str:
    text = CONFIG.read_text(encoding="utf-8")
    m = re.search(r'^version:\s*["\']?([^"\'\s]+)["\']?', text, re.MULTILINE)
    if not m:
        raise SystemExit("version not found in config.yaml")
    return m.group(1).strip()


def parse_semver(v: str) -> tuple[int, int, int]:
    parts = v.split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        raise SystemExit(f"Invalid semver: {v} (expected X.Y.Z)")
    return int(parts[0]), int(parts[1]), int(parts[2])


def bump(v: str, kind: str) -> str:
    major, minor, patch = parse_semver(v)
    if kind == "major":
        return f"{major + 1}.0.0"
    if kind == "minor":
        return f"{major}.{minor + 1}.0"
    if kind == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise SystemExit(f"Unknown bump kind: {kind}")


def replace_config(version: str) -> None:
    text = CONFIG.read_text(encoding="utf-8")
    text, n = re.subn(
        r'^version:\s*["\']?[^"\'\s]+["\']?',
        f'version: "{version}"',
        text,
        count=1,
        flags=re.MULTILINE,
    )
    if n != 1:
        raise SystemExit("Failed to update config.yaml version")
    CONFIG.write_text(text, encoding="utf-8")


def replace_build(version: str) -> None:
    text = BUILD.read_text(encoding="utf-8")
    text, n = re.subn(
        r'io\.hass\.version:\s*["\'][^"\']+["\']',
        f'io.hass.version: "{version}"',
        text,
        count=1,
    )
    if n != 1:
        raise SystemExit("Failed to update build.yaml io.hass.version")
    BUILD.write_text(text, encoding="utf-8")


def replace_readme(version: str) -> None:
    text = README.read_text(encoding="utf-8")
    text, n = re.subn(
        r"Latest addon version:\s*\S+",
        f"Latest addon version: {version}",
        text,
        count=1,
    )
    if n != 1:
        raise SystemExit("Failed to update README.md version line")
    README.write_text(text, encoding="utf-8")


def ensure_changelog(version: str, note: str | None = None) -> None:
    text = CHANGELOG.read_text(encoding="utf-8")
    if re.search(rf"^##\s+{re.escape(version)}\b", text, re.MULTILINE):
        return
    body = note or "- Document changes for this release."
    section = f"## {version}\n\n### Changed\n{body}\n\n"
    if text.startswith("# Changelog"):
        # Insert after title
        lines = text.splitlines(keepends=True)
        out = []
        inserted = False
        for i, line in enumerate(lines):
            out.append(line)
            if not inserted and line.startswith("# Changelog"):
                # skip following blank lines then insert
                j = i + 1
                while j < len(lines) and lines[j].strip() == "":
                    out.append(lines[j])
                    j += 1
                out.append(section)
                out.extend(lines[j:])
                inserted = True
                break
        text = "".join(out) if inserted else section + text
    else:
        text = f"# Changelog\n\n{section}" + text
    CHANGELOG.write_text(text, encoding="utf-8")


def sync(version: str, changelog_note: str | None = None) -> None:
    replace_config(version)
    replace_build(version)
    replace_readme(version)
    ensure_changelog(version, changelog_note)
    print(f"Synced version → {version}")
    print("  - hadomotics/config.yaml")
    print("  - hadomotics/build.yaml")
    print("  - README.md")
    print("  - CHANGELOG.md")


def main() -> int:
    parser = argparse.ArgumentParser(description="Bump/sync HADomotics version")
    parser.add_argument(
        "kind",
        nargs="?",
        choices=["patch", "minor", "major"],
        help="Semantic version bump type",
    )
    parser.add_argument("--set", dest="set_version", help="Set exact version X.Y.Z")
    parser.add_argument(
        "--sync",
        action="store_true",
        help="Propagate current config.yaml version to other files",
    )
    parser.add_argument(
        "--note",
        help="Optional one-line note for new CHANGELOG section",
    )
    args = parser.parse_args()

    current = get_version()

    if args.sync and not args.kind and not args.set_version:
        sync(current, args.note)
        return 0

    if args.set_version:
        new = args.set_version
        parse_semver(new)
    elif args.kind:
        new = bump(current, args.kind)
    else:
        parser.print_help()
        return 1

    print(f"{current} → {new}")
    sync(new, args.note)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
