#!/usr/bin/env python3
"""Configure the public bootstrap after a real TURN host is deployed and verified."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parents[1] / "config" / "network-bootstrap.json"
HOST_RE = re.compile(r"^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[A-Za-z]{2,63}$")


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {Path(sys.argv[0]).name} <deployed-turn-hostname>", file=sys.stderr)
        return 2

    hostname = sys.argv[1].strip().lower().rstrip(".")
    if not HOST_RE.fullmatch(hostname) or any(word in hostname for word in ("example", "invalid", "localhost", "test")):
        print("Refusing to configure a placeholder or invalid hostname.", file=sys.stderr)
        return 2

    if not CONFIG_PATH.is_file():
        print(f"Bootstrap config not found: {CONFIG_PATH}", file=sys.stderr)
        return 2

    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    if config.get("schemaVersion") != 1:
        print("Unsupported network bootstrap schema; refusing to rewrite it.", file=sys.stderr)
        return 2

    config["turnCredentialsUrl"] = f"https://{hostname}/api/v1/turn-credentials"
    stun_urls = config.get("stunUrls")
    if not isinstance(stun_urls, list):
        print("Bootstrap stunUrls must be a JSON array.", file=sys.stderr)
        return 2
    turn_stun = f"stun:{hostname}:3478"
    config["stunUrls"] = list(dict.fromkeys([*stun_urls, turn_stun]))
    CONFIG_PATH.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    print(f"Updated {CONFIG_PATH.relative_to(Path(__file__).resolve().parents[1])}")
    print(f"TURN credential endpoint: https://{hostname}/api/v1/turn-credentials")
    print(f"Added STUN endpoint: {turn_stun}")
    print("Next: review, commit, and merge this config change to main. Never include server secrets.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
