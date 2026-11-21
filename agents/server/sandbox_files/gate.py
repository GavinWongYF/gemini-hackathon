"""The guard on the library. Runs before every file write and shell command.

A rule set may only be saved into /workspace/library/ when a passing test
result for that name already exists in /workspace/tests/. Test results may
only be written by evaluate.py. This script sees the file name or the shell
command, never the file's content, so audit.py checks afterwards that what
was saved is what was tested.

To refuse a call it prints {"decision": "deny", "reason": "..."}. Every call
is logged to /workspace/hook_log/gate.jsonl.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time

LIBRARY = "workspace/library/"
TESTS = "/workspace/tests"
LOG = "/workspace/hook_log/gate.jsonl"
GUARDED = (".agents/", "workspace/hook_log/", "workspace/tests/", "workspace/tools/")
FILE_TOOLS = ("write_file", "write_to_file", "replace_file_content", "delete_file")
SHELL_TOOLS = ("execute_code", "code_execution")
PATH_KEYS = ("path", "file_path", "target_file", "TargetFile", "AbsolutePath", "filename")
READ_ONLY = ("ls", "cat", "head", "tail", "find", "wc", "grep", "stat", "diff", "cd", "test", "mkdir", "echo", "pwd")
SPLIT = re.compile(r"&&|\|\||[;|\n]")
NAME = re.compile(r"library/([A-Za-z0-9_.\-]+)\.json")
REDIRECT = re.compile(r">>?\s*['\"]?[^\s'\"]*(library|tests|hook_log|\.agents|tools)/")
PY_WRITE = ("open(", "write", "dump", "copy", "move", "rename", "remove", "unlink")


def passing(name: str) -> bool:
    """Whether evaluate.py has saved a passing result for this name."""
    try:
        with open(os.path.join(TESTS, name + ".json")) as handle:
            return json.load(handle).get("passed") is True
    except (OSError, ValueError):
        return False


def clean(path: str) -> str:
    return os.path.normpath(str(path)).lstrip("/")


def check_names(names: list[str]) -> str | None:
    missing = [name for name in names if not passing(name)]
    if missing:
        return (f"library/{missing[0]}.json blocked: no passing test at tests/{missing[0]}.json. "
                f"Run python3 /workspace/tools/evaluate.py on candidates/{missing[0]}.json first.")
    return None


def judge_file(tool: str, path: str) -> tuple[bool, str | None]:
    """(is this a save into the library, the reason to refuse it or None)."""
    path = clean(path)
    if path.startswith(LIBRARY):
        if tool == "delete_file":
            return False, None
        name = os.path.splitext(os.path.basename(path))[0]
        return True, check_names([name])
    if any(path.startswith(folder) for folder in GUARDED):
        return False, f"{path} blocked: this folder is written by the test tools, not by hand."
    return False, None


def judge_shell(code: str, language: str) -> tuple[bool, str | None]:
    """The same rule for a shell command or a script."""
    if language and language.lower() not in ("bash", "sh", "shell"):
        if "library/" in code and any(word in code for word in PY_WRITE):
            names = NAME.findall(code)
            if not names:
                return True, "Name each library file you save, like library/<name>.json."
            return True, check_names(names)
        return False, None
    save = False
    for part in SPLIT.split(code):
        words = part.strip().split()
        if not words:
            continue
        redirect = REDIRECT.search(part)
        if redirect and redirect.group(1) != "library":
            return save, f"Blocked: {redirect.group(1)}/ is written by the test tools, not by hand."
        if "library/" not in part:
            continue
        command = os.path.basename(words[0])
        testing = "evaluate.py" in part and command.startswith("python")
        if (command in READ_ONLY or testing) and not redirect:
            continue
        save = True
        names = NAME.findall(part)
        if not names:
            return True, "Name each library file you save, like library/<name>.json."
        reason = check_names(names)
        if reason:
            return True, reason
    return save, None


def main() -> None:
    raw = sys.stdin.read()
    try:
        call = (json.loads(raw).get("tool_call") or {})
    except ValueError:
        call = {}
    tool = str(call.get("name") or "")
    args = call.get("args") or {}
    save, reason = False, None
    if tool in SHELL_TOOLS or "code" in args:
        save, reason = judge_shell(str(args.get("code") or ""), str(args.get("language") or "bash"))
    elif tool in FILE_TOOLS or any(key in args for key in PATH_KEYS):
        path = next((args[key] for key in PATH_KEYS if key in args), "")
        save, reason = judge_file(tool, str(path))
    decision = "deny" if reason else "allow"
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a") as handle:
            handle.write(json.dumps({
                "t": round(time.time(), 2), "tool": tool, "save": save, "decision": decision,
                "reason": reason, "args": {key: str(value)[:300] for key, value in args.items()},
            }) + "\n")
    except OSError:
        pass
    print(json.dumps({"decision": "deny", "reason": reason} if reason else {"decision": "allow"}))


if __name__ == "__main__":
    main()
