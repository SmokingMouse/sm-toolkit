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
import shutil
import signal
import socket
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
    parser.add_argument("--backend", choices=["codex", "claude"], default="codex")
    parser.add_argument("--transport", choices=["ws", "unix"], default="ws")
    parser.add_argument("--allow-version-mismatch", action="store_true", help="upgrade regression only; record candidate version")
    parser.add_argument("--expect", default="thread_started,turn_completed,approval_roundtrip,resume_ok,interrupt_ok,resume_fresh_ok,multi_thread_ok,fork_ok,reconnect_ok,external_client_reply_while_attached_ok,list_contains_both_backends,display_disconnect_ok")
    parser.add_argument("--timeout", type=float, default=360)
    args = parser.parse_args()
    expected = set(args.expect.split(","))
    known = {"thread_started", "turn_completed", "approval_roundtrip", "resume_ok", "interrupt_ok", "resume_fresh_ok",
             "agent_message_delta", "command_execution_output", "user_input_question", "tool_permission_question", "display_disconnect_ok", "unsupported_method_errors", "multi_thread_ok", "fork_ok", "reconnect_ok", "external_client_reply_while_attached_ok", "list_contains_both_backends"}
    if not expected <= known:
        parser.error("unknown expectation: " + str(expected - known))
    # macOS sun_path is 104 bytes; its default per-user TMPDIR is too long.
    root = Path(tempfile.mkdtemp(prefix="as-codex-remote-", dir="/tmp")).resolve()
    home = root / "home"
    codex_home = home / ".codex"
    state = home / ".agent-server"
    workspace = root / "workspace"
    for directory in [home, codex_home, state, workspace]:
        directory.mkdir(parents=True, exist_ok=True)
    mixed = "list_contains_both_backends" in expected
    if args.backend == "claude" or mixed:
        # Reuse existing login only; never request or create credentials. Keep
        # global allowlists/hooks out of the isolated approval smoke.
        config = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude")))
        credentials = config / ".credentials.json"
        if not credentials.is_file():
            raise RuntimeError("blocker: existing Claude credentials unavailable")
        (home / ".claude").mkdir(mode=0o700)
        shutil.copyfile(credentials, home / ".claude" / ".credentials.json")
        os.chmod(home / ".claude" / ".credentials.json", 0o600)
        (home / ".claude.json").write_text(json.dumps({"hasCompletedOnboarding": True}))
        (home / ".claude" / "settings.json").write_text(json.dumps({"permissions": {"ask": ["Bash", "Read"]}}))
    wire = root / "wire.ndjson"
    wire.write_text("")
    model_calls = []
    model_lock = threading.Lock()
    held_stream = threading.Event()
    release_stream = threading.Event()
    hold_marker = "INGRESS_SMOKE_HOLD_UNTIL_INTERRUPT"
    fresh_marker = "INGRESS_SMOKE_FRESH_TURN"
    fresh_response = "INGRESS_SMOKE_FRESH_COMPLETED"
    offline_marker = "INGRESS_SMOKE_OFFLINE"
    offline_release = threading.Event()
    stop_model = threading.Event()
    smoke_command = "printf ingress-approved > ingress-proof.txt; printf INGRESS_COMMAND_OUTPUT"

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
            latest = json.dumps(user_inputs[-1]) if user_inputs else ""
            if "S3_REPLY_" in latest:
                import re
                marker = re.search(r"S3_REPLY_[A-Z0-9_]+", latest).group(0)
                item = {"type": "message", "id": "msg_s3_" + str(count), "role": "assistant", "status": "completed", "phase": "final_answer", "content": [{"type": "output_text", "text": marker, "annotations": []}]}
            elif user_inputs and offline_marker in json.dumps(user_inputs[-1]):
                offline_release.wait(args.timeout)
                item = {"type": "message", "id": "msg_offline_" + str(count), "role": "assistant", "status": "completed", "phase": "final_answer", "content": [{"type": "output_text", "text": offline_marker, "annotations": []}]}
            elif user_inputs and fresh_marker in json.dumps(user_inputs[-1]):
                item = {"type": "message", "id": "msg_fresh_" + str(count), "role": "assistant", "status": "completed", "phase": "final_answer", "content": [{"type": "output_text", "text": fresh_response, "annotations": []}]}
            elif not tool_returned:
                names = [t.get("name") for t in body.get("tools", [])]
                if "exec_command" in names:
                    name, arguments = "exec_command", {"cmd": smoke_command, "workdir": str(workspace), "yield_time_ms": 1000}
                elif "shell_command" in names:
                    name, arguments = "shell_command", {"command": smoke_command, "workdir": str(workspace)}
                else:
                    name, arguments = "shell", {"command": ["/bin/sh", "-c", smoke_command], "workdir": str(workspace)}
                arguments.update({"sandbox_permissions": "require_escalated", "justification": "Approve the isolated ingress smoke proof file?"})
                item = {"type": "function_call", "id": "fc_smoke", "call_id": "call_smoke", "name": name, "arguments": json.dumps(arguments)}
                # 0.153.4 may expose tools only via code-mode additional_tools.
                namespaces = [tool for entry in body.get("input", []) if entry.get("type") == "additional_tools" for tool in entry.get("tools", [])]
                if any(t.get("name") == "functions" and any(x.get("name") == "exec" for x in t.get("tools", [])) for t in namespaces):
                    arguments = {"cmd": smoke_command, "workdir": str(workspace), "sandbox_permissions": "require_escalated", "justification": "Approve the isolated ingress smoke proof file?"}
                    item = {"type": "custom_tool_call", "id": "fc_smoke", "call_id": "call_smoke", "name": "exec", "namespace": "functions", "input": "text(await tools.exec_command(" + json.dumps(arguments) + "));"}
            else:
                item = {"type": "message", "id": "msg_smoke", "role": "assistant", "status": "completed", "phase": "final_answer", "content": [{"type": "output_text", "text": "INGRESS_SMOKE_COMPLETED", "annotations": []}]}
            output_items = [item]
            if "S3_REPLY_LONG_HISTORY" in latest:
                output_items = [{**item, "id": "long_" + str(n), "phase": "commentary", "content": [{"type": "output_text", "text": "History item " + str(n), "annotations": []}]} for n in range(210)] + [item]
            for index, item in enumerate(output_items):
                if item["type"] == "message":
                    events.append({"type": "response.output_item.added", "output_index": index, "item": {**item, "content": [], "status": "in_progress"}})
                    events.append({"type": "response.content_part.added", "output_index": index, "item_id": item["id"], "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}})
                    events.append({"type": "response.output_text.delta", "output_index": index, "item_id": item["id"], "content_index": 0, "delta": item["content"][0]["text"]})
                    events.append({"type": "response.output_text.done", "output_index": index, "item_id": item["id"], "content_index": 0, "text": item["content"][0]["text"]})
                    events.append({"type": "response.content_part.done", "output_index": index, "item_id": item["id"], "content_index": 0, "part": item["content"][0]})
                events.append({"type": "response.output_item.done", "output_index": index, "item": item})
            events.append({"type": "response.completed", "response": {"id": response_id, "status": "completed", "output": output_items, "usage": {"input_tokens": 50, "output_tokens": 10, "total_tokens": 60}}})
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
    (codex_home / "config.toml").write_text('''model = %s
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
''' % (json.dumps("sonnet" if args.backend == "claude" else "gpt-5.6-sol"), model.server_port, json.dumps(str(workspace))))
    (state / "config.toml").write_text('allowed_roots = [%s]\ndefault_model = %s\n[codex_ingress]\nenabled = true\nclaude_threads = %s\nport = 0\n' % (json.dumps(str(workspace)), json.dumps("sonnet" if args.backend == "claude" else "gpt-5.6-sol"), "true" if args.backend == "claude" or mixed else "false"))
    if args.transport == "unix":
        with (state / "config.toml").open("a") as file:
            file.write('unix_path = "default"\n')
    env = {"PATH": os.environ["PATH"], "HOME": str(home), "CODEX_HOME": str(codex_home), "TERM": "xterm-256color", "LANG": "en_US.UTF-8", "TMPDIR": str(root), "NO_PROXY": "*", "no_proxy": "*", "CODEX_SMOKE_ROOT": str(root), "AGENT_SERVER_SOCKET_PATH": str(root / "as.sock")}
    env["CODEX_SMOKE_TRANSPORT"] = args.transport
    env["CODEX_SMOKE_BACKEND"] = args.backend
    env["CODEX_SMOKE_MIXED"] = "1" if mixed else "0"
    runner = Path(__file__).with_name("codex-remote-smoke-daemon.ts").resolve()
    log = open(root / "daemon-output.log", "wb")
    daemon = subprocess.Popen(["bun", str(runner)], cwd=workspace, env=env, stdout=log, stderr=log, start_new_session=True)
    tui = None
    master = None
    selected_thread = None
    output = bytearray()
    proof = {name: False for name in known}
    summary = {"artifact_dir": str(root), "backend": args.backend, "transport": args.transport, "model": "real Claude CLI --model sonnet" if args.backend == "claude" else "local deterministic Responses fixture", "proof": proof}
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
                if frame.get("method") == "error" and not frame.get("params", {}).get("willRetry", False):
                    raise RuntimeError("native execution error while " + label + ": " + json.dumps(frame["params"]["error"]))
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
        nonlocal tui, master, selected_thread
        selected_thread = None
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 150, 0, 0))
        command = ["codex", "--remote", endpoint["url"], "--no-alt-screen"]
        if args.transport == "ws":
            command += ["--remote-auth-token-env", "SMOKE_BEARER"]
        # --model is a sticky override on every native resume, including the
        # other backend. The config default selects the first thread instead;
        # subsequent picker selections must inherit their saved model.
        command += extra or []
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

    def settle(seconds=0.6):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            pump()

    def response_to(method, offset, thread=None):
        current = frames()[offset:]
        requests = [f for f in current if f.get("direction") == "TUI>AS" and f.get("method") == method and (thread is None or f.get("params", {}).get("threadId") == thread)]
        return next((f["result"] for r in requests for f in current if f.get("direction") == "AS>TUI" and f.get("id") == r["id"] and f.get("connection") == r.get("connection") and "result" in f), None)

    def switch(thread, picker=False, title="S3-FRESH"):
        nonlocal selected_thread
        if selected_thread == thread and not picker:
            return
        offset = len(frames())
        prompt("/resume" if picker else "/resume " + thread)
        if picker:
            wait(lambda: response_to("thread/list", offset) is not None, "real resume picker listed threads")
            listed = response_to("thread/list", offset)["data"]
            assert {fresh_id, thread_id} <= {t["id"] for t in listed}, "picker missing managed threads"
            settle()
            os.write(master, title.encode())
            # The picker filters already-fetched rows locally before requesting
            # further pages, so a search does not necessarily issue another RPC.
            settle()
            os.write(master, b"\r")
        wait(lambda: response_to("thread/resume", offset, thread) is not None, "same connection switched " + thread)
        selected_thread = thread
        settle()

    def small_turn(thread, marker):
        nonlocal selected_thread
        offset, output_offset = len(frames()), len(output)
        prompt("Do not use tools. Reply with exactly: " + marker)
        wait(lambda: any(f.get("method") == "turn/completed" and f["params"].get("threadId") == thread and f["params"]["turn"]["status"] == "completed" for f in frames()[offset:]), "alternating turn completed on " + thread)
        requests = [f for f in frames()[offset:] if f.get("direction") == "TUI>AS" and f.get("method") == "turn/start"]
        assert len(requests) == 1 and requests[0]["params"]["threadId"] == thread, "turn routed to wrong thread"
        assert any(f.get("method") == "item/completed" and f["params"].get("threadId") == thread and marker in f["params"].get("item", {}).get("text", "") for f in frames()[offset:]), "wrong response/thread association"
        wait(lambda: marker.encode() in output[output_offset:], "TUI rendered alternating response")
        selected_thread = thread
        settle(0.3)

    try:
        version = subprocess.check_output(["codex", "--version"], env=env, text=True).strip()
        summary["codex_version"] = version
        if version != "codex-cli 0.153.4" and not args.allow_version_mismatch:
            raise RuntimeError("pinned codex-cli 0.153.4 required, found " + version)
        wait(lambda: (root / "smoke-endpoint.json").exists(), "daemon startup")
        endpoint = json.loads((root / "smoke-endpoint.json").read_text())
        env["SMOKE_BEARER"] = Path(endpoint["tokenPath"]).read_text().strip()
        fresh_id = endpoint["freshThreadId"]
        summary["fresh_thread_id"] = fresh_id
        with sqlite3.connect(endpoint["databasePath"]) as db:
            assert db.execute("SELECT count(*) FROM turns WHERE thread_id = ?", (endpoint["freshAsThreadId"],)).fetchone()[0] == 0, "as/1 thread is not fresh"
        launch(["-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"', "resume", fresh_id])
        def fresh_resumed():
            current = frames()
            requests = [f for f in current if f.get("direction") == "TUI>AS" and f.get("method") == "thread/resume" and f["params"]["threadId"] == fresh_id]
            return any(f.get("connection") == r.get("connection") and f.get("id") == r["id"] and f.get("direction") == "AS>TUI" and f.get("result", {}).get("thread", {}).get("id") == fresh_id and f["result"]["thread"]["turns"] == [] for r in requests for f in current)
        wait(fresh_resumed, "as/1 fresh thread resume with empty history")
        with sqlite3.connect(endpoint["databasePath"]) as db:
            assert db.execute("SELECT count(*) FROM approvals WHERE thread_id = ?", (endpoint["freshAsThreadId"],)).fetchone()[0] == 0, "full resume created an approval row"
        until = time.monotonic() + 0.7
        while time.monotonic() < until:
            pump()
        prompt(fresh_marker if args.backend == "codex" else "Do not use tools. Reply with exactly: " + fresh_response)
        def fresh_completed():
            current = frames()
            started_ids = {f["params"]["turn"]["id"] for f in current if f.get("method") == "turn/started" and f["params"].get("threadId") == fresh_id}
            return any(f.get("method") == "turn/completed" and f["params"].get("threadId") == fresh_id and f["params"]["turn"]["id"] in started_ids and f["params"]["turn"]["status"] == "completed" for f in current)
        wait(fresh_completed, "first real turn completed on as/1 fresh thread")
        wait(lambda: fresh_response.encode() in output, "TUI rendered fresh response")
        proof["resume_fresh_ok"] = True
        if "multi_thread_ok" in expected:
            name_offset = len(frames())
            prompt("/rename S3-FRESH")
            wait(lambda: response_to("thread/name/set", name_offset, fresh_id) is not None, "fresh picker name")
        # A second process speaks real as/1 over the daemon's Unix socket while
        # the official full-permission TUI stays attached. Keep every frame.
        full_resumes = [f for f in frames() if f.get("direction") == "TUI>AS" and f.get("method") == "thread/resume" and f["params"].get("threadId") == fresh_id]
        assert full_resumes and full_resumes[-1]["params"].get("approvalPolicy") == "never" and full_resumes[-1]["params"].get("sandbox") == "danger-full-access", "TUI did not resume with explicit full permission"
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as external:
            external.connect(env["AGENT_SERVER_SOCKET_PATH"])
            external_id, pending_bytes = 0, b""

            def external_rpc(method, params):
                nonlocal external_id, pending_bytes
                external_id += 1
                request = {"jsonrpc": "2.0", "id": external_id, "method": method, "params": params}
                with open(root / "external-as1.ndjson", "a") as stream:
                    stream.write(json.dumps({"direction": "client>AS", **request, "params": {k: v for k, v in params.items() if k != "token"}}) + "\n")
                external.sendall((json.dumps(request) + "\n").encode())
                response = None

                def received():
                    nonlocal pending_bytes, response
                    if select.select([external], [], [], 0)[0]:
                        chunk = external.recv(65536)
                        if not chunk:
                            raise RuntimeError("external as/1 disconnected")
                        pending_bytes += chunk
                    while b"\n" in pending_bytes:
                        line, pending_bytes = pending_bytes.split(b"\n", 1)
                        frame = json.loads(line)
                        with open(root / "external-as1.ndjson", "a") as stream:
                            stream.write(json.dumps({"direction": "AS>client", **frame}) + "\n")
                        if frame.get("id") == external_id:
                            if "error" in frame:
                                raise RuntimeError("external " + method + ": " + json.dumps(frame["error"]))
                            response = frame["result"]
                    return response is not None

                wait(received, "external as/1 " + method + " while full TUI attached")
                return response

            external_rpc("initialize", {"protocolVersion": "as/1", "token": env["SMOKE_BEARER"], "client": {"name": "external-smoke", "version": "1", "kind": "cli", "label": "external-smoke"}, "capabilities": {}})
            external.sendall(b'{"jsonrpc":"2.0","method":"initialized","params":{}}\n')
            attached = external_rpc("thread/attach", {"threadId": endpoint["freshAsThreadId"]})
            assert attached["thread"]["permission"] == "full"
            external_before = len(frames())
            reply = external_rpc("turn/start", {"threadId": endpoint["freshAsThreadId"], "input": [{"type": "text", "text": fresh_marker if args.backend == "codex" else "Do not use tools. Reply with exactly: " + fresh_response}]})
            wait(lambda: any(f.get("method") == "turn/completed" and f["params"].get("threadId") == fresh_id and f["params"]["turn"]["status"] == "completed" for f in frames()[external_before:]), "TUI observed external reply completion")
            with sqlite3.connect(endpoint["databasePath"]) as db:
                assert json.loads(db.execute("SELECT data_json FROM turns WHERE id = ?", (reply["turn"]["id"],)).fetchone()[0])["status"] == "completed", "external reply did not complete"
            assert tui.poll() is None
            offline_before = len(frames())
            prompt(offline_marker if args.backend == "codex" else "Use Bash to run exactly: sleep 3; printf INGRESS_SMOKE_OFFLINE . Then reply exactly INGRESS_SMOKE_OFFLINE.")
            wait(lambda: any(f.get("method") == "turn/started" and f["params"].get("threadId") == fresh_id for f in frames()[offline_before:]), "offline turn started")
            with sqlite3.connect(endpoint["databasePath"]) as db:
                offline_turn = db.execute("SELECT id,status FROM turns WHERE thread_id = ? ORDER BY ordinal DESC LIMIT 1", (endpoint["freshAsThreadId"],)).fetchone()
            assert offline_turn[1] == "inProgress", "offline turn already ended before display crash"
            tui.kill()  # actual official display crash, not a native unsubscribe
            tui.wait(timeout=3)
            stop_tui()
            offline_release.set()
            def offline_completed():
                with sqlite3.connect(endpoint["databasePath"]) as db:
                    row = db.execute("SELECT data_json FROM turns WHERE id = ?", (offline_turn[0],)).fetchone()
                turn = json.loads(row[0])
                if turn["status"] in {"failed", "interrupted"}:
                    raise RuntimeError("display crash terminated engine turn: " + json.dumps(turn))
                return turn["status"] == "completed"
            wait(offline_completed, "daemon turn completes after official TUI SIGKILL")
            assert not any(f.get("method") == "turn/interrupt" and f.get("direction") == "TUI>AS" for f in frames()[offline_before:])
            summary["offline_turn"] = {"id": offline_turn[0], "status_at_display_crash": offline_turn[1], "status_after": "completed", "signal": "SIGKILL"}
            proof["display_disconnect_ok"] = True
            reconnect_before = len(frames())
            launch(["-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"', "resume", fresh_id])
            wait(lambda: any(f.get("result", {}).get("thread", {}).get("id") == fresh_id for f in frames()[reconnect_before:]), "display replacement resumed completed thread")
            wait(lambda: offline_marker.encode() in output, "display replacement rendered offline completion")
            until = time.monotonic() + 0.7
            while time.monotonic() < until:
                pump()
            closed = external_rpc("thread/close", {"threadId": endpoint["freshAsThreadId"]})
            assert closed == {}
            # Claude's closed notification makes the official TUI disconnect
            # from this task. End that PTY before preparing the later picker.
            stop_tui()
            assert external_rpc("thread/read", {"threadId": endpoint["freshAsThreadId"]})["thread"]["status"]["type"] == "closed"
            summary["external_client"] = {"permission": "full", "turn_id": reply["turn"]["id"], "close_ack": closed, "tui_alive_after_reply": True}
            proof["external_client_reply_while_attached_ok"] = True
            # The later picker exercise still needs this managed thread live.
            external_rpc("thread/resume", {"threadId": endpoint["freshAsThreadId"], "permission": "auto-edit", **({"sandbox": "workspace-write"} if args.backend == "codex" else {})})
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
        prompt("Please run the requested smoke command and report completion." if args.backend == "codex" else "Use only Bash to run exactly: " + smoke_command + " . Do not read any files or use other tools. After Bash succeeds reply exactly INGRESS_SMOKE_COMPLETED.")
        wait(lambda: any(f.get("method") == "item/commandExecution/requestApproval" for f in frames()), "approval card")
        if "reconnect_ok" in expected:
            original = next(f for f in frames() if f.get("method") == "item/commandExecution/requestApproval")
            stop_tui()
            with sqlite3.connect(endpoint["databasePath"]) as db:
                row = db.execute("SELECT status, engine_thread_id FROM threads WHERE " + ("id" if args.backend == "claude" else "engine_thread_id") + " = ?", (("th_" + thread_id) if args.backend == "claude" else thread_id,)).fetchone()
                assert row and row[0] != "closed", "disconnect closed the thread"
                engine_id = row[1]
            reconnect_offset = len(frames())
            launch(["resume", thread_id])
            wait(lambda: response_to("thread/resume", reconnect_offset, thread_id) is not None and any(f.get("method") == "item/commandExecution/requestApproval" for f in frames()[reconnect_offset:]), "reconnect pending replay")
            replay = next(f for f in frames()[reconnect_offset:] if f.get("method") == "item/commandExecution/requestApproval")
            assert replay["id"] != original["id"] and replay["params"] == original["params"], "pending replay changed payload or reused connection ID"
            assert any(f.get("method") == "serverRequest/resolved" and f["params"]["requestId"] == original["id"] for f in frames()[reconnect_offset:]), "old card was not retired"
            with sqlite3.connect(endpoint["databasePath"]) as db:
                assert db.execute("SELECT count(*) FROM threads WHERE engine_thread_id = ? AND status != 'closed'", (engine_id,)).fetchone()[0] == 1, "reconnect replaced the engine thread"
            summary["reconnect"] = {"old_wire_id": original["id"], "new_wire_id": replay["id"], "engine_thread_id": engine_id}
        # This is the actual terminal approval interaction, not a protocol response.
        until = time.monotonic() + 2.0
        while time.monotonic() < until:
            pump()
        os.write(master, b"y")
        wait(lambda: any(f.get("method") == "turn/completed" and f["params"].get("threadId") == thread_id and f["params"]["turn"]["status"] == "completed" for f in frames()), "completed turn after approval")
        proof["turn_completed"] = True
        wait(lambda: b"INGRESS_SMOKE_COMPLETED" in output, "TUI rendered completed response")
        wait(lambda: any(f.get("direction") == "TUI>AS" and f.get("method") == "thread/name/set" and f["params"]["threadId"] == thread_id for f in frames()), "TUI assigned thread title")
        with sqlite3.connect(endpoint["databasePath"]) as db:
            db.row_factory = sqlite3.Row
            approvals = [dict(row) for row in db.execute("SELECT id,thread_id,kind,status,decided_by,decision_json FROM approvals")]
            persisted = json.loads(db.execute("SELECT data_json FROM threads WHERE " + ("id" if args.backend == "claude" else "engine_thread_id") + " = ?", (("th_" + thread_id) if args.backend == "claude" else thread_id,)).fetchone()[0])
        current = frames()
        names = [f for f in current if f.get("direction") == "TUI>AS" and f.get("method") == "thread/name/set" and f["params"]["threadId"] == thread_id]
        assert names, "real TUI did not request a thread name"
        assert all(any(r.get("connection") == n.get("connection") and r.get("id") == n["id"] and r.get("direction") == "AS>TUI" and r.get("result") == {} for r in current) for n in names), "thread/name/set not acknowledged"
        assert persisted["title"] == names[-1]["params"]["name"].strip(), "thread name not persisted"
        summary["persisted_title"] = persisted["title"]
        summary["approvals"] = approvals
        proof["approval_roundtrip"] = any(row["status"] == "decided" and json.loads(row["decided_by"] or "{}").get("label", "").startswith("codex-tui:") for row in approvals) and (workspace / "ingress-proof.txt").read_text() == "ingress-approved" and any(f.get("method") == "serverRequest/resolved" for f in frames())
        if "reconnect_ok" in expected:
            proof["reconnect_ok"] = proof["approval_roundtrip"] and any(f.get("method") == "serverRequest/resolved" and f["params"]["requestId"] == replay["id"] for f in frames())
        wait(lambda: b"INGRESS_SMOKE_COMPLETED" in output, "TUI rendered completed response")
        if args.backend == "claude":
            question_offset = len(frames())
            prompt("Use the Read tool to read " + str(workspace / "ingress-proof.txt") + ". Do not use Bash or any other tool. Then reply exactly INGRESS_READ_COMPLETED.")
            wait(lambda: any(f.get("method") == "item/tool/requestUserInput" for f in frames()[question_offset:]), "Read permission projected as requestUserInput")
            card = next(f for f in frames()[question_offset:] if f.get("method") == "item/tool/requestUserInput")
            assert card["params"]["questions"][0]["header"] == "权限请求：Read"
            until = time.monotonic() + 1
            while time.monotonic() < until:
                pump()
            # The first option is allow; submit through the real TUI question UI.
            os.write(master, b"\r")
            wait(lambda: any(f.get("direction") == "TUI>AS" and f.get("id") == card["id"] and f.get("connection") == card["connection"] and "result" in f for f in frames()[question_offset:]), "TUI submitted Read permission answer")
            wait(lambda: any(f.get("method") == "turn/completed" and f["params"].get("threadId") == thread_id and f["params"]["turn"]["status"] == "completed" for f in frames()[question_offset:]), "Read completed through broker")
            with sqlite3.connect(endpoint["databasePath"]) as db:
                db.row_factory = sqlite3.Row
                reads = [dict(row) for row in db.execute("SELECT id,kind,status,decided_by,decision_json FROM approvals WHERE kind = 'item/permissions/requestApproval'")]
            summary["read_permission_approvals"] = reads
            proof["user_input_question"] = any(row["status"] == "decided" and json.loads(row["decision_json"])["permissions"].get("toolName") == "Read" and json.loads(row["decided_by"]).get("label", "").startswith("codex-tui:") for row in reads) and any(f.get("method") == "serverRequest/resolved" and f["params"]["requestId"] == card["id"] for f in frames()[question_offset:])
            assert proof["user_input_question"], "Read permission did not close through AS broker"
            proof["tool_permission_question"] = proof["user_input_question"]
            assert any(f.get("method") == "item/completed" and f.get("params", {}).get("item", {}).get("tool") == "Read" and f["params"]["item"].get("success") is True for f in frames()[question_offset:]), "Read tool did not execute successfully"
            wait(lambda: b"INGRESS_READ_COMPLETED" in output, "TUI rendered Read completion")
        if "multi_thread_ok" in expected:
            multi_offset = len(frames())
            switch(fresh_id, picker=True)
            small_turn(fresh_id, "S3_REPLY_FIRST_A")
            switch(thread_id)
            small_turn(thread_id, "S3_REPLY_SECOND_A")
            switch(fresh_id)
            small_turn(fresh_id, "S3_REPLY_FIRST_B")
            switch(thread_id)
            small_turn(thread_id, "S3_REPLY_SECOND_B")
            connections = {f["connection"] for f in frames()[multi_offset:] if f.get("direction") == "TUI>AS" and f.get("method") == "turn/start"}
            assert len(connections) == 1, "multi-thread test used multiple TUI connections"
            proof["multi_thread_ok"] = True
        if mixed:
            mixed_offset = len(frames())
            other_id = endpoint["mixedThreadId"]
            other_backend = "claude" if args.backend == "codex" else "codex"
            switch(other_id, picker=True, title="S3-MIXED-" + other_backend.upper())
            approval_offset = len(frames())
            prompt("Use only Bash to run exactly: " + smoke_command + " . Do not read any files or use other tools. After Bash succeeds reply exactly INGRESS_SMOKE_COMPLETED.")
            wait(lambda: any(f.get("method") == "item/commandExecution/requestApproval" for f in frames()[approval_offset:]), "other backend approval card")
            card = next(f for f in frames()[approval_offset:] if f.get("method") == "item/commandExecution/requestApproval")
            assert card["params"]["threadId"] == other_id, "cross-backend approval routed to primary thread"
            assert any(f.get("method") == "turn/started" and f["params"].get("threadId") == other_id and f["params"]["turn"]["id"] == card["params"]["turnId"] for f in frames()[approval_offset:]), "approval turn does not belong to other backend"
            settle(2)
            os.write(master, b"y")
            wait(lambda: any(f.get("method") == "turn/completed" and f["params"].get("threadId") == other_id and f["params"]["turn"]["status"] == "completed" for f in frames()[approval_offset:]), "other backend approval completed")
            assert any(f.get("method") == "serverRequest/resolved" and f["params"].get("requestId") == card["id"] and f["params"].get("threadId") == other_id for f in frames()[approval_offset:]), "other backend approval resolution crossed threads"
            # Both engines remain loaded while the PTY alternates real turns.
            for target, marker in [(thread_id, "S3_REPLY_MIX_PRIMARY_A"), (other_id, "S3_REPLY_MIX_OTHER_A"), (thread_id, "S3_REPLY_MIX_PRIMARY_B"), (other_id, "S3_REPLY_MIX_OTHER_B")]:
                switch(target)
                small_turn(target, marker)
            interrupts = []
            for target, backend, peer in [(other_id, other_backend, thread_id), (thread_id, args.backend, other_id)]:
                switch(target)
                offset = len(frames())
                held_stream.clear()
                release_stream.clear()
                prompt(hold_marker if backend == "codex" else "Do not use tools. Write a very long numbered list from 1 to 10000, spelling out each number in English. Start immediately and keep writing until 10000.")
                wait(lambda: held_stream.is_set() if backend == "codex" else any(f.get("method") == "item/agentMessage/delta" and f["params"].get("threadId") == target for f in frames()[offset:]), "mixed backend active stream")
                active = next(f["params"]["turn"]["id"] for f in frames()[offset:] if f.get("method") == "turn/started" and f["params"].get("threadId") == target)
                os.write(master, b"\x1b")
                wait(lambda: response_to("turn/interrupt", offset, target) is not None and any(f.get("method") == "turn/completed" and f["params"].get("threadId") == target and f["params"]["turn"]["id"] == active and f["params"]["turn"]["status"] == "interrupted" for f in frames()[offset:]), "mixed interrupt isolated to active thread")
                assert not any(f.get("method") in {"turn/completed", "turn/interrupt"} and f.get("params", {}).get("threadId") == peer for f in frames()[offset:]), "interrupt affected other backend"
                interrupts.append({"thread_id": target, "turn_id": active, "backend": backend})
                release_stream.set()
                settle()
                switch(peer)
                small_turn(peer, "S3_REPLY_MIX_SURVIVED_" + backend.upper())
            release_stream.clear()
            held_stream.clear()
            current = frames()[mixed_offset:]
            connections = {f["connection"] for f in current if f.get("direction") == "TUI>AS" and f.get("method") in {"turn/start", "turn/interrupt", "thread/resume"}}
            assert len(connections) == 1, "mixed backends did not share the TUI main connection"
            listed = response_to("thread/list", mixed_offset)["data"]
            metadata = {t["id"]: t for t in listed}
            backend_ids = {args.backend: thread_id, other_backend: other_id}
            assert metadata[backend_ids["claude"]]["modelProvider"] == "claude" and metadata[backend_ids["claude"]]["model"] == "sonnet"
            assert metadata[backend_ids["codex"]]["modelProvider"] == "smoke" and metadata[backend_ids["codex"]]["model"] == "gpt-5.6-sol"
            loaded = [f["result"]["data"] for r in current if r.get("method") == "thread/loaded/list" and r.get("direction") == "TUI>AS" for f in current if f.get("connection") == r["connection"] and f.get("id") == r["id"] and "result" in f]
            assert any({thread_id, other_id} <= set(ids) for ids in loaded), "loaded/list missing mixed backends"
            primary_card = next(f for f in frames() if f.get("method") == "item/commandExecution/requestApproval" and f["params"].get("threadId") == thread_id and f.get("connection") in connections)
            assert card["connection"] == primary_card["connection"] and card["id"] != primary_card["id"], "mixed approval IDs collided or used different connections"
            summary["mixed_backends"] = {"connection": next(iter(connections)), "threads": backend_ids, "metadata": {k: metadata[v] for k, v in backend_ids.items()}, "loaded_lists": loaded, "interrupts": interrupts, "approvals": [primary_card, card]}
            proof["list_contains_both_backends"] = True
            switch(thread_id)
        if "fork_ok" in expected:
            fork_offset = len(frames())
            prompt("/fork")
            # Outside a git repository, the official checkout picker offers
            # only the existing directory. Select it if no RPC was sent yet.
            settle()
            if not any(f.get("method") == "thread/fork" for f in frames()[fork_offset:]):
                os.write(master, b"\r")
            wait(lambda: response_to("thread/fork", fork_offset, thread_id) is not None, "official TUI fork")
            fork_id = response_to("thread/fork", fork_offset, thread_id)["thread"]["id"]
            assert fork_id != thread_id, "fork reused parent UUID"
            settle()
            small_turn(fork_id, "S3_REPLY_FORK_A")
            switch(thread_id)
            switch(fork_id)
            small_turn(fork_id, "S3_REPLY_FORK_B")
            if args.backend == "codex":
                small_turn(fork_id, "S3_REPLY_LONG_HISTORY")
                history = subprocess.Popen(["bun", str(Path(__file__).with_name("codex-remote-history.ts")), endpoint["nativeUrl"], fork_id, str(root / "history-proof.json")], env=env, stdout=log, stderr=log)
                wait(lambda: history.poll() is not None, "long native history pagination probe")
                assert history.returncode == 0, "long history probe failed; see daemon-output.log"
                summary["history"] = json.loads((root / "history-proof.json").read_text())["summary"]
            summary["fork_thread_id"] = fork_id
            proof["fork_ok"] = True
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
        prompt(hold_marker if args.backend == "codex" else "Do not use tools. Write a very long numbered list from 1 to 10000, spelling out each number in English. Start immediately and keep writing until 10000.")
        if args.backend == "codex":
            wait(lambda: held_stream.is_set() and any(f.get("method") == "turn/started" for f in frames()[before:]), "resumed model stream open and held")
        else:
            wait(lambda: any(f.get("method") == "item/agentMessage/delta" for f in frames()[before:]), "real Claude resumed stream producing text")
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
        if args.backend == "claude" or mixed:
            init_frames = [json.loads(line)["params"]["payload"] for line in (root / "claude-init.ndjson").read_text().splitlines()]
            summary["claude_init_models"] = [f.get("model") for f in init_frames]
            assert init_frames and all("sonnet" in f.get("model", "").lower() for f in init_frames), "Claude init did not confirm sonnet"
        else:
            summary["model_stream_held_until_interrupt"] = not release_stream.is_set()
        release_stream.set()
    except Exception as error:
        summary["error"] = str(error)
        summary["traceback"] = traceback.format_exc()
    finally:
        offline_release.set()
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
        proof["agent_message_delta"] = any(f.get("method") == "item/agentMessage/delta" and f.get("params", {}).get("delta") for f in current)
        # Claude Bash reports a terminal aggregate, not stdout/stderr deltas.
        proof["command_execution_output"] = any(f.get("method") == "item/completed" and f.get("params", {}).get("item", {}).get("type") == "commandExecution" and "INGRESS_COMMAND_OUTPUT" in f["params"]["item"].get("aggregatedOutput", "") for f in current)
        summary["command_output_semantics"] = "completed commandExecution.aggregatedOutput contains INGRESS_COMMAND_OUTPUT"
        summary["question_semantics"] = "tool_permission_question verifies Read permission via requestUserInput; user_input_question is a deprecated alias, neither asserts AskUserQuestion/multiSelect"
        unsupported = root / "unsupported-methods.json"
        if unsupported.exists():
            summary["unsupported_methods"] = json.loads(unsupported.read_text())
            proof["unsupported_method_errors"] = all(f.get("error", {}).get("code") == -32601 and f["error"]["message"].startswith("as-ingress: ") for f in summary["unsupported_methods"]) and len(summary["unsupported_methods"]) == 2
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
