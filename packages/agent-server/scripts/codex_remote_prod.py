"""Production half of codex-remote-smoke.py: existing daemon, real user config.

Uses read-only SQLite evidence to associate each unique workspace/marker with
the thread created by the official TUI. Never starts or stops a daemon.
"""
import fcntl
import copy
import json
import os
from pathlib import Path
import pty
import select
import signal
import socket
import sqlite3
import struct
import subprocess
import tempfile
import termios
import time
import traceback
import uuid


def run_prod(args):
    root = (args.out or Path(tempfile.mkdtemp(prefix="as-prod-smoke-", dir="/tmp"))).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if args.backend == "both":
        results = []
        for backend in ("codex", "claude"):
            child = copy.copy(args)
            child.backend, child.out = backend, root / backend
            code = run_prod(child)
            results.append({"backend": backend, "exit": code, "summary": str(child.out / "summary.json")})
            if code:
                break
        passed = len(results) == 2 and all(r["exit"] == 0 for r in results)
        report = {"mode": "prod", "backend": "both", "results": results, "proof": {"fresh_tui_session_ok": passed}, "passed": passed}
        (root / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2), flush=True)
        return 0 if passed else 1
    endpoint = json.loads(args.endpoint.read_text())
    home = Path.home()
    state = Path(os.environ["XDG_STATE_HOME"]) / "sm-toolkit/agent-server" if os.environ.get("XDG_STATE_HOME") else home / ".agent-server"
    token_path = Path(endpoint.get("tokenPath", state / "token"))
    if not token_path.is_file():
        raise RuntimeError("blocker: existing daemon token unavailable")
    token = token_path.read_text().strip()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("FENJUE_", "HERDR_"))}
    env.update(TERM="xterm-256color", AS_PROD_SMOKE_TOKEN=token)
    report = {"mode": "prod", "endpoint": str(args.endpoint), "pid": endpoint["pid"], "backend": args.backend, "runs": [], "proof": {"fresh_tui_session_ok": False}}
    sock = socket.socket(socket.AF_UNIX)
    sock.settimeout(15)
    db = None
    try:
        os.kill(endpoint["pid"], 0)
        sock.connect(endpoint["socketPath"])
        stream = sock.makefile("rb")
        serial = 0

        def rpc(method, params):
            nonlocal serial
            serial += 1
            sock.sendall((json.dumps({"jsonrpc": "2.0", "id": serial, "method": method, "params": params}) + "\n").encode())
            while True:
                line = stream.readline()
                if not line:
                    raise RuntimeError("AS socket closed")
                frame = json.loads(line)
                if frame.get("id") == serial:
                    if "error" in frame:
                        raise RuntimeError(str(frame["error"]))
                    return frame["result"]

        rpc("initialize", {"protocolVersion": "as/1", "token": token, "client": {"name": "production-smoke", "version": "1", "kind": "cli", "label": "production-smoke"}, "capabilities": {}})
        sock.sendall(b'{"jsonrpc":"2.0","method":"initialized","params":{}}\n')
        report["health"] = rpc("server/health", {})
        config = rpc("server/config/read", {})
        # Remain inside the daemon's real allowlist, independent of caller cwd.
        workspace = Path(tempfile.mkdtemp(prefix="codex-prod-smoke-", dir=config["allowed_roots"][0]))
        report["workspace"] = str(workspace)
        db = sqlite3.connect("file:" + str(endpoint.get("databasePath", state / "agent-server.db")) + "?mode=ro", uri=True)
        for index in range(args.runs):
            marker = "PROD_SMOKE_" + uuid.uuid4().hex.upper()
            existing = {r[0] for r in db.execute("SELECT id FROM threads")}
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 150, 0, 0))
            # Codex uses the user's default model; Claude is selected at cold start.
            command = ["codex", "--remote", endpoint["codexIngressUrl"], "--remote-auth-token-env", "AS_PROD_SMOKE_TOKEN", "--no-alt-screen"]
            if args.backend == "claude":
                command += ["--model", "sonnet"]
            proc = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, cwd=workspace, env=env, start_new_session=True)
            os.close(slave)
            output, pending = bytearray(), b""

            def pump():
                nonlocal pending
                if not select.select([master], [], [], .1)[0]:
                    return
                try:
                    data = os.read(master, 65536)
                except OSError:
                    return
                output.extend(data)
                pending += data
                for query, reply in [(b"\x1b[6n", b"\x1b[1;1R"), (b"\x1b[c", b"\x1b[?1;2c"), (b"\x1b[>c", b"\x1b[>0;0;0c"), (b"\x1b[?u", b"\x1b[?0u")]:
                    while query in pending:
                        os.write(master, reply)
                        pending = pending.replace(query, b"", 1)
                pending = pending[-12:]

            def settle(seconds):
                until = time.monotonic() + seconds
                while time.monotonic() < until:
                    pump()

            def send(text):
                os.write(master, b"\x1b[200~" + text.encode() + b"\x1b[201~")
                settle(.3)
                os.write(master, b"\r")

            try:
                deadline = time.monotonic() + min(60, args.timeout)
                while True:
                    pump()
                    created = [r for r in db.execute("SELECT id,backend,json_extract(data_json,'$.model') FROM threads WHERE cwd=?", (str(workspace),)) if r[0] not in existing]
                    if len(created) == 1:
                        break
                    if proc.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("TUI failed to create unique " + args.backend + " thread; see PTY artifact")
                thread, backend, model = created[0]
                assert backend == args.backend, "wrong backend: " + backend
                settle(2)
                before_prompt = len(output)
                # The full marker is absent from user input, so visible evidence
                # cannot accidentally match the TUI's echo of our prompt.
                send("Do not use tools. Reply only with these two strings concatenated, without spaces: " + marker[:16] + " and " + marker[16:])
                deadline = time.monotonic() + args.timeout
                while True:
                    pump()
                    rows = db.execute("SELECT id,status FROM turns WHERE thread_id=?", (thread,)).fetchall()
                    if any(r[1] in ("failed", "interrupted") for r in rows):
                        raise RuntimeError("Production turn failed: " + str(rows))
                    completed = [r for r in rows if r[1] == "completed"]
                    if completed:
                        items = [json.loads(r[0]) for r in db.execute("SELECT payload_json FROM items WHERE turn_id=? AND type='agentMessage'", (completed[0][0],))]
                        assert any(marker in i.get("text", "") for i in items), "No assistant marker"
                        settle(1)
                        assert marker.encode() in output[before_prompt:], "No visible TUI marker"
                        break
                    if proc.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("Production turn timeout")
                send("/quit")
                deadline = time.monotonic() + 15
                while proc.poll() is None and time.monotonic() < deadline:
                    pump()
                assert proc.poll() == 0, "/quit failed"
                assert json.loads(args.endpoint.read_text())["pid"] == endpoint["pid"], "Daemon changed during smoke"
                report["runs"].append({"backend": backend, "model": model, "thread": thread, "turn": completed[0][0], "marker": marker, "tui_exit": 0})
            finally:
                if proc.poll() is None:
                    os.killpg(proc.pid, signal.SIGTERM)
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait()
                os.close(master)
                (root / f"prod-{args.backend}-{index + 1}.pty").write_bytes(output)
        report["proof"]["fresh_tui_session_ok"] = len({r["thread"] for r in report["runs"]}) == args.runs
    except Exception as error:
        report.update(error=str(error), traceback=traceback.format_exc())
    finally:
        sock.close()
        if db is not None:
            db.close()
        report["passed"] = report["proof"]["fresh_tui_session_ok"] and "error" not in report
        report["artifact_dir"] = str(root)
        (root / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2), flush=True)
    return 0 if report["passed"] else 1
