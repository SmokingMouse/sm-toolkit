# /// script
# requires-python = ">=3.10"
# dependencies = ["jsonschema==4.23.0"]
# ///
"""Check a candidate Codex binary without changing the pinned baseline.

Usage: scripts/codex-ingress-upgrade-check.sh --codex /path/to/codex --out /tmp/report
Any schema drift fails closed, but all regressions still run and are reported.
"""
import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from jsonschema import Draft7Validator


def compare_schemas(baseline, candidate, output):
    old = {str(p.relative_to(baseline)): json.loads(p.read_text()) for p in baseline.rglob("*.json")}
    new = {str(p.relative_to(candidate)): json.loads(p.read_text()) for p in candidate.rglob("*.json")}
    errors, changed = [], []
    for name, schema in new.items():
        try:
            Draft7Validator.check_schema(schema)
        except Exception as error:
            errors.append({"file": name, "error": str(error)})
    def lines(value):
        return json.dumps(value, indent=2, sort_keys=True).splitlines(True)
    with (output / "schema.diff").open("w") as diff:
        for name in sorted(old.keys() | new.keys()):
            if old.get(name) != new.get(name):
                changed.append(name)
                diff.writelines(difflib.unified_diff(lines(old.get(name)), lines(new.get(name)), fromfile="pinned/" + name, tofile="candidate/" + name))
    methods = {}
    for group in ["ClientRequest", "ClientNotification", "ServerRequest", "ServerNotification"]:
        def names(schemas):
            return {m for v in schemas.get(group + ".json", {}).get("oneOf", []) for m in v.get("properties", {}).get("method", {}).get("enum", [])}
        before, after = names(old), names(new)
        methods[group] = {"pinned_count": len(before), "candidate_count": len(after), "added": sorted(after - before), "removed": sorted(before - after)}
    return {"valid": not errors and bool(new), "errors": errors, "changed_files": changed, "methods": methods, "candidate_files": len(new)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", default=shutil.which("codex"))
    parser.add_argument("--out", type=Path)
    parser.add_argument("--runs", type=int, default=3)
    args = parser.parse_args()
    if args.runs < 1 or not args.codex:
        parser.error("codex binary and runs >= 1 required")
    repo = Path(__file__).resolve().parents[3]
    binary = Path(args.codex).absolute()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        parser.error("candidate must be an executable file")
    output = (args.out or Path(tempfile.mkdtemp(prefix="as-upgrade-", dir="/tmp"))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    pinned = (repo / "docs/agent-server/codex-schema-version.txt").read_text().strip()
    baseline = repo / "docs/agent-server/codex-schema" / pinned
    candidate = output / "candidate-schema"
    candidate.mkdir(exist_ok=False)
    launchers = output / "bin"
    launchers.mkdir(exist_ok=True)
    (launchers / "codex").symlink_to(binary)
    env = {**os.environ, "PATH": str(launchers) + os.pathsep + os.environ["PATH"]}
    report = {"pinned": pinned, "candidate_binary": str(binary), "candidate_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "runs": args.runs, "checks": []}
    def run(label, command, cwd=repo):
        started = time.monotonic()
        with (output / (label + ".log")).open("w") as log:
            try:
                result = subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
                code = result.returncode
            except (OSError, subprocess.TimeoutExpired) as error:
                log.write(str(error)); code = 124
        report["checks"].append({"label": label, "command": command, "cwd": str(cwd), "exit": code, "seconds": round(time.monotonic() - started, 2)})
        print(f"{label}: exit={code}", flush=True)
        return code
    run("version", ["codex", "--version"])
    report["candidate_version"] = (output / "version.log").read_text().strip()
    code = run("generate-schema", ["codex", "app-server", "generate-json-schema", "--experimental", "--out", str(candidate)])
    if code == 0:
        report["schema"] = compare_schemas(baseline, candidate, output)
        run("required-field-alignment", ["bun", "run", "packages/agent-server/scripts/check-codex-alignment.ts", "--candidate-schema-dir", str(candidate)])
    else:
        report["schema"] = {"valid": False, "changed_files": [], "errors": ["generation failed"]}
    run("agent-server-tests", ["bun", "test"], repo / "packages/agent-server")
    run("typecheck", ["bun", "run", "typecheck"])
    common = "thread_started,turn_completed,approval_roundtrip,resume_ok,interrupt_ok,resume_fresh_ok,external_client_reply_while_attached_ok,display_disconnect_ok,agent_message_delta,command_execution_output,unsupported_method_errors,multi_thread_ok,fork_ok,reconnect_ok,list_contains_both_backends"
    for backend in ["codex", "claude"]:
        for transport in ["ws", "unix"]:
            expected = common + (",tool_permission_question" if backend == "claude" else "")
            for index in range(1, args.runs + 1):
                run(f"smoke-{backend}-{transport}-{index}", ["python3", "packages/agent-server/scripts/codex-remote-smoke.py", "--backend", backend, "--transport", transport, "--expect", expected, "--allow-version-mismatch", "--timeout", "900"])
    report["passed"] = report["schema"]["valid"] and not report["schema"]["changed_files"] and all(c["exit"] == 0 for c in report["checks"])
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    rows = [f"# Codex ingress 升级回归\n\npinned={pinned}; candidate={report['candidate_version']}\n\n通过：{report['passed']}\n\nSchema 差异文件：{len(report['schema']['changed_files'])}；完整差异见 schema.diff。\n\n| 检查 | exit | 秒 |\n|---|---|---|\n"]
    rows += [f"| {c['label']} | {c['exit']} | {c['seconds']} |\n" for c in report["checks"]]
    (output / "report.md").write_text("".join(rows))
    print(f"pinned={pinned} passed={report['passed']} report={output / 'report.json'}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
