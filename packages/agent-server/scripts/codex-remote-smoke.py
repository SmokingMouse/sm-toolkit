#!/usr/bin/env python3
"""PTY end-to-end smoke: official Codex TUI + official app-server + real AS broker.

Only the model Responses endpoint is deterministic/local (no credentials needed).
All native frames come from the real binaries. Artifacts remain in a mktemp dir.
"""
import argparse
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import select
import signal
import sqlite3
import struct
import subprocess
import tempfile
import termios
import threading
import time
import traceback


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=["codex"], default="codex")
    parser.add_argument("--expect", default="thread_started,turn_completed,approval_roundtrip,resume_ok,interrupt_ok")
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    expected = set(args.expect.split(","))
    known = {"thread_started", "turn_completed", "approval_roundtrip", "resume_ok", "interrupt_ok"}
    if not expected <= known:
        parser.error("unknown expectation: " + str(expected - known))
    root = Path(tempfile.mkdtemp(prefix="as-codex-remote-")).resolve()
    home = root / "home"
    codex_home = home / ".codex"
    state = home / ".agent-server"
    workspace = root / "workspace"
    for directory in [home, codex_home, state, workspace]:
        directory.mkdir(parents=True, exist_ok=True)
    wire = root / "wire.ndjson"
    wire.write_text("")
    model_calls = []
    model_lock = threading.Lock()
    interrupted_request = threading.Event()
    stop_model = threading.Event()

    class Model(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *unused):
            pass

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("content-length", 0)))
            try:
                body = json.loads(raw)
            except Exception:
                self.send_error(400, "uncompressed JSON required")
                return
            with model_lock:
                model_calls.append(body)
                (root / "model-requests.json").write_text(json.dumps(model_calls, indent=2))
                count = len(model_calls)
            # Hold the third model response until the TUI sends a real interrupt.
            if count >= 3:
                interrupted_request.set()
                stop_model.wait(args.timeout)
                self.close_connection = True
                return
            response_id = "smoke-response-" + str(count)
            events = [{"type": "response.created", "response": {"id": response_id}}]
            if count == 1:
                names = [t.get("name") for t in body.get("tools", [])]
                if "exec_command" in names:
                    name, arguments = "exec_command", {"cmd": "printf ingress-approved > ingress-proof.txt", "workdir": str(workspace), "yield_time_ms": 1000}
                elif "shell_command" in names:
                    name, arguments = "shell_command", {"command": "printf ingress-approved > ingress-proof.txt", "workdir": str(workspace)}
                else:
                    name, arguments = "shell", {"command": ["/bin/sh", "-c", "printf ingress-approved > ingress-proof.txt"], "workdir": str(workspace)}
                arguments.update({"sandbox_permissions": "require_escalated", "justification": "Approve the isolated ingress smoke proof file?"})
                item = {"type": "function_call", "id": "fc_smoke", "call_id": "call_smoke", "name": name, "arguments": json.dumps(arguments)}
                # 0.153.4 may expose tools only via code-mode additional_tools.
                namespaces = [tool for entry in body.get("input", []) if entry.get("type") == "additional_tools" for tool in entry.get("tools", [])]
                if any(t.get("name") == "functions" and any(x.get("name") == "exec" for x in t.get("tools", [])) for t in namespaces):
                    arguments = {"cmd": "printf ingress-approved > ingress-proof.txt", "workdir": str(workspace), "sandbox_permissions": "require_escalated", "justification": "Approve the isolated ingress smoke proof file?"}
                    item = {"type": "custom_tool_call", "id": "fc_smoke", "call_id": "call_smoke", "name": "exec", "namespace": "functions", "input": "text(await tools.exec_command(" + json.dumps(arguments) + "));"}
            else:
                item = {"type": "message", "id": "msg_smoke", "role": "assistant", "status": "completed", "phase": "final_answer", "content": [{"type": "output_text", "text": "INGRESS_SMOKE_COMPLETED", "annotations": []}]}
            events.append({"type": "response.output_item.done", "output_index": 0, "item": item})
            events.append({"type": "response.completed", "response": {"id": response_id, "status": "completed", "output": [item], "usage": {"input_tokens": 50, "output_tokens": 10, "total_tokens": 60}}})
            data = "".join("data: " + json.dumps(event) + "\n\n" for event in events).encode()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=model.serve_forever, daemon=True).start()
    (codex_home / "config.toml").write_text('''model = "gpt-5.6-sol"
model_provider = "smoke"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
check_for_update_on_startup = false
[model_providers.smoke]
name = "Local deterministic smoke model"
base_url = "http://127.0.0.1:%d/v1"
wire_api = "responses"
requires_openai_auth = false
[projects.%s]
trust_level = "trusted"
''' % (model.server_port, json.dumps(str(workspace))))
    (state / "config.toml").write_text('allowed_roots = [%s]\ndefault_model = "gpt-5.6-sol"\n[codex_ingress]\nenabled = true\nport = 0\n' % json.dumps(str(workspace)))
    env = {"PATH": os.environ["PATH"], "HOME": str(home), "CODEX_HOME": str(codex_home), "TERM": "xterm-256color", "LANG": "en_US.UTF-8", "TMPDIR": str(root), "NO_PROXY": "*", "no_proxy": "*", "CODEX_SMOKE_ROOT": str(root), "AGENT_SERVER_SOCKET_PATH": str(root / "as.sock")}
    runner = Path(__file__).with_name("codex-remote-smoke-daemon.ts").resolve()
    log = open(root / "daemon-output.log", "wb")
    daemon = subprocess.Popen(["bun", str(runner)], cwd=workspace, env=env, stdout=log, stderr=log, start_new_session=True)
    tui = None
    master = None
    output = bytearray()
    proof = {name: False for name in known}
    summary = {"artifact_dir": str(root), "model": "local deterministic Responses fixture", "proof": proof}
    started = time.monotonic()

    def frames():
        # appendFileSync writes complete lines, but tolerate a reader racing a write.
        result = []
        for line in wire.read_text().splitlines():
            try:
                result.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        return result

    def pump(timeout=0.05):
        if master is None or not select.select([master], [], [], timeout)[0]:
            return
        try:
            data = os.read(master, 65536)
        except OSError:
            return
        output.extend(data)
        with open(root / "tui-output.bin", "ab") as stream:
            stream.write(data)
        # Query replies can be split across reads; retain just the unprocessed tail.
        pump.pending += data
        replies = [(b"\x1b[6n", b"\x1b[1;1R"), (b"\x1b[c", b"\x1b[?1;2c"), (b"\x1b[>c", b"\x1b[>0;0;0c"), (b"\x1b[?u", b"\x1b[?0u")]
        for query, answer in replies:
            while query in pump.pending:
                os.write(master, answer)
                pump.pending = pump.pending.replace(query, b"", 1)
        pump.pending = pump.pending[-12:]

    pump.pending = b""

    def wait(predicate, label):
        while time.monotonic() - started < args.timeout:
            pump()
            if predicate():
                return
            current = frames()
            # These optional startup UI features are explicitly denied in slice 1.
            requests, errors = {}, []
            for frame in current:
                key = (frame.get("connection"), frame.get("id"))
                if frame.get("direction") == "TUI>AS" and "method" in frame:
                    requests[key] = frame["method"]
                if "error" in frame and not (requests.get(key) in {"thread/name/set", "thread/goal/get"} and frame["error"]["code"] == -32601):
                    errors.append(frame["error"])
            if errors:
                raise RuntimeError("native RPC error while " + label + ": " + json.dumps(errors[-1]))
            if daemon.poll() is not None:
                raise RuntimeError("daemon exited while " + label)
            if tui is not None and tui.poll() is not None:
                raise RuntimeError("official TUI exited while " + label)
        raise TimeoutError(label)

    def launch(extra=None):
        nonlocal tui, master
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 150, 0, 0))
        command = ["codex", "--remote", endpoint["url"], "--remote-auth-token-env", "SMOKE_BEARER", "--no-alt-screen"] + (extra or [])
        tui = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, cwd=workspace, env=env, start_new_session=True)
        os.close(slave)

    def stop_tui():
        nonlocal tui, master
        if tui is not None and tui.poll() is None:
            os.write(master, b"\x03")
            until = time.monotonic() + 0.4
            while time.monotonic() < until:
                pump()
            if tui.poll() is None:
                os.write(master, b"\x03")
            try:
                tui.wait(timeout=3)
            except subprocess.TimeoutExpired:
                tui.terminate()
                tui.wait(timeout=3)
        if master is not None:
            os.close(master)
            master = None
        tui = None

    def prompt(text):
        os.write(master, b"\x1b[200~" + text.encode() + b"\x1b[201~")
        until = time.monotonic() + 0.3
        while time.monotonic() < until:
            pump()
        os.write(master, b"\r")

    try:
        version = subprocess.check_output(["codex", "--version"], env=env, text=True).strip()
        summary["codex_version"] = version
        if version != "codex-cli 0.153.4":
            raise RuntimeError("pinned codex-cli 0.153.4 required, found " + version)
        wait(lambda: (root / "smoke-endpoint.json").exists(), "daemon startup")
        endpoint = json.loads((root / "smoke-endpoint.json").read_text())
        env["SMOKE_BEARER"] = Path(endpoint["tokenPath"]).read_text().strip()
        launch()
        wait(lambda: any(f.get("method") == "thread/started" for f in frames()), "thread start")
        first = next(f for f in frames() if f.get("method") == "thread/started")
        thread_id = first["params"]["thread"]["id"]
        summary["thread_id"] = thread_id
        proof["thread_started"] = True
        # Wait for initialization to settle before pasting the turn into the PTY.
        until = time.monotonic() + 0.6
        while time.monotonic() < until:
            pump()
        prompt("Please run the requested smoke command and report completion.")
        wait(lambda: any(f.get("method") == "item/commandExecution/requestApproval" for f in frames()), "approval card")
        # This is the actual terminal approval interaction, not a protocol response.
        until = time.monotonic() + 2.0
        while time.monotonic() < until:
            pump()
        os.write(master, b"y")
        wait(lambda: any(f.get("method") == "turn/completed" and f["params"]["turn"]["status"] == "completed" for f in frames()), "completed turn after approval")
        proof["turn_completed"] = True
        with sqlite3.connect(endpoint["databasePath"]) as db:
            db.row_factory = sqlite3.Row
            approvals = [dict(row) for row in db.execute("SELECT id,thread_id,kind,status,decided_by,decision_json FROM approvals")]
        summary["approvals"] = approvals
        proof["approval_roundtrip"] = any(row["status"] == "decided" and json.loads(row["decided_by"] or "{}").get("label", "").startswith("codex-tui:") for row in approvals) and (workspace / "ingress-proof.txt").read_text() == "ingress-approved" and any(f.get("method") == "serverRequest/resolved" for f in frames())
        stop_tui()
        before = len(frames())
        launch(["resume", thread_id])
        def resumed():
            current = frames()[before:]
            ids = {f["id"] for f in current if f.get("method") == "thread/resume"}
            return any(f.get("id") in ids and f.get("result", {}).get("thread", {}).get("id") == thread_id for f in current)
        wait(resumed, "resume response")
        until = time.monotonic() + 0.7
        while time.monotonic() < until:
            pump()
        prompt("Wait for my interruption.")
        wait(interrupted_request.is_set, "second model turn")
        proof["resume_ok"] = True # resumed TUI loaded history and submitted another real turn
        os.write(master, b"\x1b")
        wait(lambda: any(f.get("method") == "turn/completed" and f["params"]["turn"]["status"] == "interrupted" for f in frames()[before:]), "interrupt completion")
        proof["interrupt_ok"] = any(f.get("method") == "turn/interrupt" and f.get("direction") == "TUI>AS" for f in frames()[before:])
    except Exception as error:
        summary["error"] = str(error)
        summary["traceback"] = traceback.format_exc()
    finally:
        stop_tui()
        stop_model.set()
        daemon.terminate()
        try:
            daemon.wait(timeout=6)
        except subprocess.TimeoutExpired:
            os.killpg(daemon.pid, signal.SIGKILL)
            daemon.wait()
        log.close()
        model.shutdown()
        model.server_close()
        (root / "tui-output.bin").write_bytes(output)
        current = frames()
        summary["wire_frames"] = len(current)
        summary["client_methods"] = list(dict.fromkeys(f["method"] for f in current if f.get("direction") == "TUI>AS" and "method" in f))
        summary["rpc_errors"] = [f for f in current if "error" in f]
        summary["elapsed_seconds"] = round(time.monotonic() - started, 2)
        summary["passed"] = all(proof[name] for name in expected) and "error" not in summary
        (root / "summary.json").write_text(json.dumps(summary, indent=2))
        print(json.dumps(summary, indent=2))
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
