#!/usr/bin/env python3
import argparse
import os
import re
import tempfile
from pathlib import Path

BEGIN = "# BEGIN claude-addons multi-model — generated"
END = "# END claude-addons multi-model"
TOP_LEVEL = re.compile(r"^([A-Za-z0-9_-]+):(?:\s|$)")
OWNED = {
    "host", "port", "auth-dir", "api-keys", "remote-management", "debug",
    "logging-to-file", "usage-statistics-enabled", "request-retry",
    "max-retry-interval", "disable-cooling", "oauth-request-scoped-errors",
    "quota-exceeded", "routing", "streaming", "claude-code",
    "oauth-model-alias", "oauth-excluded-models",
}


def strip_owned(text):
    kept = []
    skipping_key = False
    skipping_generated = False
    for line in text.splitlines(keepends=True):
        bare = line.rstrip("\r\n")
        if bare == BEGIN:
            skipping_generated = True
            skipping_key = False
            continue
        if skipping_generated:
            if bare == END:
                skipping_generated = False
            continue
        match = TOP_LEVEL.match(line) if line and not line[0].isspace() else None
        if match:
            skipping_key = match.group(1) in OWNED
        elif line.strip() and not line[0].isspace() and not line.lstrip().startswith("#"):
            skipping_key = False
        if not skipping_key:
            kept.append(line)
    return "".join(kept).rstrip()


def merge(existing, template, local_key):
    if not local_key or "\n" in local_key or "\r" in local_key:
        raise ValueError("local key must contain one non-empty line")
    generated = template.replace("__LOCAL_KEY__", local_key).rstrip()
    prefix = strip_owned(existing)
    return (prefix + "\n\n" if prefix else "") + BEGIN + "\n" + generated + "\n" + END + "\n"


def atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--template", required=True, type=Path)
    parser.add_argument("--local-key", required=True)
    args = parser.parse_args()

    existing = args.config.read_text() if args.config.exists() else ""
    wanted = merge(existing, args.template.read_text(), args.local_key)
    if wanted == existing:
        print("same")
        return
    atomic_write(args.config, wanted)
    os.chmod(args.config, 0o600)
    print("changed")


if __name__ == "__main__":
    main()
