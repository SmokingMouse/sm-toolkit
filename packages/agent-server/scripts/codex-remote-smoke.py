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
    parser.add_argument("--expect", default="thread_started,turn_completed,approval_roundtrip,resume_ok,interrupt_ok,resume_fresh_ok")
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    expected = set(args.expect.split(","))
    known = {"thread_started", "turn_completed", "approval_roundtrip", "resume_ok", "interrupt_ok", "resume_fresh_ok"}
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
    held_stream = threading.Event()
    release_stream = threading.Event()
    hold_marker = "INGRESS_SMOKE_HOLD_UNTIL_INTERRUPT"
    fresh_marker = "INGRESS_SMOKE_FRESH_TURN"
    fresh_response = "INGRESS_SMOKE_FRESH_COMPLETED"
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
            # Identify the resumed user turn by content, never by HTTP count:
            # retries/auxiliary requests must not change the fixture's phase.
            user_inputs = [entry for entry in body.get("input", []) if entry.get("role") == "user"]
            if user_inputs and hold_marker in json.dumps(user_inputs[-1]):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(('data: ' + json.dumps({"type": "response.created", "response": {"id": "held-response"}}) + '\n\n').encode())
                self.wfile.flush()
                held_stream.set()
                # No completed event or EOF before the real interruption has
                # been acknowledged and observed on this exact native turn.
                while not release_stream.wait(0.1) and not stop_model.is_set():
                    pass
                self.close_connection = True
                return
            response_id = "smoke-response-" + str(count)
            events = [{"type": "response.created", "response": {"id": response_id}}]
            tool_returned = any(entry.get("type") in {"function_call_output", "custom_tool_call_output"} and entry.get("call_id") == "call_smoke" for entry in body.get("input", []))
            if user_inputs and fresh_marker in json.dumps(user_inputs[-1]):
                item = {"type": "message", "id": "msg_fresh", "role": "assistant", "status": "completed", "phase": "final_answer", "content": [{"type": "output_text", "text": fresh_response, "annotations": []}]}
            elif not tool_returned:
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
            current = frames()
            # These optional startup UI features are explicitly denied in slice 1.
            requests, errors = {}, []
            for frame in current:
                key = (frame.get("connection"), frame.get("id"))
                if frame.get("direction") == "TUI>AS" and "method" in frame:
                    requests[key] = frame
                if "error" in frame:
                    request = requests.get(key, {})
                    optional_goal = request.get("method") == "thread/goal/get" and frame["error"]["code"] == -32601
                    # TUI's optional generated-title helper asks for a separate
                    # ephemeral system thread with forbidden config overrides.
                    # Its rejection is expected; the real name/set must succeed.
                    p = request.get("params", {})
                    optional_title = request.get("method") == "thread/start" and p.get("ephemeral") is True and p.get("threadSource") == "system" and frame["error"]["code"] == -32008
                    if not (optional_goal or optional_title):
                        errors.append(frame["error"])
            if errors:
                raise RuntimeError("native RPC error while " + label + ": " + json.dumps(errors[-1]))
            if daemon.poll() is not None:
                raise RuntimeError("daemon exited while " + label)
            if tui is not None and tui.poll() is not None:
                raise RuntimeError("official TUI exited while " + label)
            if predicate():
                return
        raise TimeoutError(label)

    def launch(extra=None):
        nonlocal tui, master
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 150, 0, 0))
        command = ["codex", "--remote", endpoint["url"], "--remote-auth-token-env", "SMOKE_BEARER", "--no-alt-screen"] + (extra or [])
        tui = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, cwd=workspace, env=env, start_new_session=True)
        os.close(slave)

    def stop_tui(graceful=False):
        nonlocal tui, master
        if tui is not None and tui.poll() is None:
            if graceful:
                # Ctrl-C can interrupt a turn whose terminal notification is
                # still in the TUI event queue. /quit never supplies a stale ID.
                prompt("/quit")
                deadline = time.monotonic() + 5
                while tui.poll() is None and time.monotonic() < deadline:
                    pump()
                if tui.poll() is None:
                    raise TimeoutError("TUI /quit")
                if tui.returncode != 0:
                    raise RuntimeError("TUI /quit exit " + str(tui.returncode))
            else:
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
        fresh_id = endpoint["freshThreadId"]
        summary["fresh_thread_id"] = fresh_id
        with sqlite3.connect(endpoint["databasePath"]) as db:
            assert db.execute("SELECT count(*) FROM turns WHERE thread_id = ?", (endpoint["freshAsThreadId"],)).fetchone()[0] == 0, "as/1 thread is not fresh"
        launch(["resume", fresh_id])
        def fresh_resumed():
            current = frames()
            requests = [f for f in current if f.get("direction") == "TUI>AS" and f.get("method") == "thread/resume" and f["params"]["threadId"] == fresh_id]
            return any(f.get("connection") == r.get("connection") and f.get("id") == r["id"] and f.get("direction") == "AS>TUI" and f.get("result", {}).get("thread", {}).get("id") == fresh_id and f["result"]["thread"]["turns"] == [] for r in requests for f in current)
        wait(fresh_resumed, "as/1 fresh thread resume with empty history")
        until = time.monotonic() + 0.7
        while time.monotonic() < until:
            pump()
        prompt(fresh_marker)
        def fresh_completed():
            current = frames()
            started_ids = {f["params"]["turn"]["id"] for f in current if f.get("method") == "turn/started" and f["params"].get("threadId") == fresh_id}
            return any(f.get("method") == "turn/completed" and f["params"].get("threadId") == fresh_id and f["params"]["turn"]["id"] in started_ids and f["params"]["turn"]["status"] == "completed" for f in current)
        wait(fresh_completed, "first real turn completed on as/1 fresh thread")
        wait(lambda: fresh_response.encode() in output, "TUI rendered fresh response")
        proof["resume_fresh_ok"] = True
        stop_tui(graceful=True)
        initial_offset = len(frames())
        launch()
        wait(lambda: any(f.get("method") == "thread/started" for f in frames()[initial_offset:]), "thread start")
        first = next(f for f in frames()[initial_offset:] if f.get("method") == "thread/started")
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
        wait(lambda: any(f.get("method") == "turn/completed" and f["params"].get("threadId") == thread_id and f["params"]["turn"]["status"] == "completed" for f in frames()), "completed turn after approval")
        proof["turn_completed"] = True
        with sqlite3.connect(endpoint["databasePath"]) as db:
            db.row_factory = sqlite3.Row
            approvals = [dict(row) for row in db.execute("SELECT id,thread_id,kind,status,decided_by,decision_json FROM approvals")]
            persisted = json.loads(db.execute("SELECT data_json FROM threads WHERE engine_thread_id = ?", (thread_id,)).fetchone()[0])
        current = frames()
        names = [f for f in current if f.get("direction") == "TUI>AS" and f.get("method") == "thread/name/set" and f["params"]["threadId"] == thread_id]
        assert names, "real TUI did not request a thread name"
        assert all(any(r.get("connection") == n.get("connection") and r.get("id") == n["id"] and r.get("direction") == "AS>TUI" and r.get("result") == {} for r in current) for n in names), "thread/name/set not acknowledged"
        assert persisted["title"] == names[-1]["params"]["name"].strip(), "thread name not persisted"
        summary["persisted_title"] = persisted["title"]
        summary["approvals"] = approvals
        proof["approval_roundtrip"] = any(row["status"] == "decided" and json.loads(row["decided_by"] or "{}").get("label", "").startswith("codex-tui:") for row in approvals) and (workspace / "ingress-proof.txt").read_text() == "ingress-approved" and any(f.get("method") == "serverRequest/resolved" for f in frames())
        wait(lambda: b"INGRESS_SMOKE_COMPLETED" in output, "TUI rendered completed response")
        stop_tui(graceful=True)
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
        prompt(hold_marker)
        wait(lambda: held_stream.is_set() and any(f.get("method") == "turn/started" for f in frames()[before:]), "resumed model stream open and held")
        resumed_frames = frames()[before:]
        turn_id = next(f["params"]["turn"]["id"] for f in resumed_frames if f.get("method") == "turn/started")
        summary["interrupted_turn_id"] = turn_id
        assert not any(f.get("method") == "turn/completed" and f["params"]["turn"]["id"] == turn_id for f in resumed_frames), "held turn completed before interrupt"
        proof["resume_ok"] = True # resumed TUI loaded history and submitted another real turn
        os.write(master, b"\x1b")
        def interrupted():
            current = frames()[before:]
            requests = [f for f in current if f.get("method") == "turn/interrupt" and f.get("direction") == "TUI>AS" and f["params"].get("turnId") == turn_id]
            ack = any(f.get("connection") == r.get("connection") and f.get("id") == r["id"] and "result" in f and f["direction"] == "AS>TUI" for r in requests for f in current)
            terminal = any(f.get("method") == "turn/completed" and f["params"]["turn"]["id"] == turn_id and f["params"]["turn"]["status"] == "interrupted" for f in current)
            return bool(requests) and ack and terminal
        wait(interrupted, "matching interrupt request, acknowledgement and terminal notification")
        proof["interrupt_ok"] = True
        summary["model_stream_held_until_interrupt"] = not release_stream.is_set()
        release_stream.set()
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
