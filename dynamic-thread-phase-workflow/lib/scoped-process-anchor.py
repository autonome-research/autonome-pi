"""Internal Linux subreaper. FD3 is private runner control, never inherited by payload.

No recovery/PID replay. TERM targets our own anchored group; KILL uses pidfds of
our unreaped children, not saved PIDs. ECHILD is the kernel subtree-empty proof.
This is cooperative process supervision, NOT a same-user/setsid sandbox.
"""
import ctypes
import json
import os
import select
import signal
import subprocess
import sys
import time

CONTROL = 3
POLL = 0.02
SHUTDOWN = 10.0
MAX_CHILDREN = 4096


def send(value):
    data = (json.dumps(value, separators=(",", ":")) + "\n").encode()
    while data:
        count = os.write(CONTROL, data)
        data = data[count:]


def main():
    if sys.platform != "linux" or os.getpgrp() != os.getpid():
        raise RuntimeError("unsupported")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise RuntimeError("subreaper unavailable")
    fd = os.pidfd_open(os.getpid())
    try:
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)
    signal.signal(signal.SIGTERM, lambda *_: None)
    send({"type": "ready", "pid": os.getpid()})
    buffer = b""
    launched = False
    payload = None
    direct = False
    stopping = None
    grace = 0.5
    bootstrap_until = time.monotonic() + 5

    dispatch = None
    term_sent = False
    preserve_worker_fd = False

    def budget():
        now = time.monotonic()
        if stopping is not None and now - stopping >= SHUTDOWN:
            raise RuntimeError("shutdown deadline")
        if not launched and stopping is None and now >= bootstrap_until:
            raise RuntimeError("bootstrap deadline")

    def check(timeout=0):
        nonlocal buffer, dispatch, stopping, grace, preserve_worker_fd
        # One parser, no recursive dispatch. Collect at most 64 KiB/four reads;
        # a still-readable flood fails unknown rather than starving action checks.
        budget()
        for attempt in range(5):
            readable, _, _ = select.select([CONTROL], [], [], timeout if attempt == 0 else 0)
            budget()
            if not readable:
                break
            if attempt == 4:
                raise RuntimeError("control work bound")
            chunk = os.read(CONTROL, 65537 - len(buffer))
            if not chunk:
                raise RuntimeError("owner lost")
            buffer += chunk
            if len(buffer) > 65536:
                raise RuntimeError("control bound")
        lines = buffer.split(b"\n")
        buffer = lines.pop()
        messages = [json.loads(line) for line in lines]
        if any(isinstance(m, dict) and m.get("type") == "revoke" for m in messages):
            raise RuntimeError("owner revoked")
        for message in messages:
            budget()
            if not isinstance(message, dict):
                raise RuntimeError("control type")
            if message.get("type") == "term" and set(message) == {"type"}:
                if stopping is None:
                    stopping = time.monotonic()
            elif message.get("type") == "dispatch" and (
                    set(message) == {"type", "argv", "graceMs"} or
                    set(message) == {"type", "argv", "graceMs", "preserveWorkerFd"} and
                    type(message["preserveWorkerFd"]) is bool):
                if launched or dispatch is not None:
                    raise RuntimeError("duplicate dispatch")
                preserve_worker_fd = message.get("preserveWorkerFd", False)
                if type(preserve_worker_fd) is not bool:
                    raise RuntimeError("bootstrap fd")
                argv, ms = message["argv"], message["graceMs"]
                if type(ms) is not int or not 1 <= ms <= 5000:
                    raise RuntimeError("grace bound")
                if not isinstance(argv, list) or not argv or not argv[0] or any(
                        not isinstance(arg, str) or "\0" in arg for arg in argv):
                    raise RuntimeError("argv")
                dispatch = argv
                grace = ms / 1000
            else:
                raise RuntimeError("control type")
        budget()

    def terminate():
        nonlocal stopping, term_sent
        if stopping is None:
            stopping = time.monotonic()
        if not term_sent:
            term_sent = True
            check()
            # Self is the still-live group anchor. Only this immediately following
            # syscall can race loss/expiry AFTER the final cooperative check.
            os.kill(0, signal.SIGTERM)

    while True:
        check(POLL)
        if stopping is not None:
            terminate()
        if dispatch is not None:
            check()
            argv, dispatch = dispatch, None
            launched = True
            if stopping is None:
                try:
                    if preserve_worker_fd:
                        os.fstat(4)
                    payload = subprocess.Popen(argv, close_fds=True, pass_fds=(4,)) if preserve_worker_fd else subprocess.Popen(argv, close_fds=True)
                    if preserve_worker_fd:
                        os.close(4)
                except OSError:
                    direct = True
                    send({"type": "direct", "code": None, "signal": None, "spawnError": True})
            else:
                direct = True
                send({"type": "direct", "code": None, "signal": None, "spawnError": False})
        if not launched and stopping is None:
            continue
        empty = False
        # No other thread or Popen.wait() reaps these children. Until waitpid,
        # even exited children retain their PID and cannot alias another process.
        for _ in range(MAX_CHILDREN):
            check()
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:  # ECHILD, including all adopted descendants
                empty = True
                break
            check()
            if pid == 0:
                break
            if payload is not None and pid == payload.pid:
                direct = True
                payload.returncode = os.waitstatus_to_exitcode(status)
                send({"type": "direct", "code": os.WEXITSTATUS(status) if os.WIFEXITED(status) else None,
                      "signal": signal.Signals(os.WTERMSIG(status)).name if os.WIFSIGNALED(status) else None,
                      "spawnError": False})
        if empty:
            check()
            send({"type": "empty"})
            return 0
        if direct and stopping is None:
            send({"type": "residual"})
            terminate()
        if stopping is not None:
            check()
            if time.monotonic() - stopping >= grace:
                # Not a global /proc audit. This file lists ONLY our current
                # children. ECHILD above, never a readable subset, proves drain.
                with open("/proc/self/task/%d/children" % os.getpid(), "rb") as children:
                    raw = children.read(65537)
                check()
                pids = raw.split()
                if len(raw) > 65536 or len(pids) > MAX_CHILDREN:
                    raise RuntimeError("child inventory bound")
                for raw_pid in pids:
                    check()
                    pid = int(raw_pid)
                    fd = os.pidfd_open(pid)
                    try:
                        if os.getpgid(pid) != os.getpgrp():
                            raise RuntimeError("escaped group")
                        check()
                        signal.pidfd_send_signal(fd, signal.SIGKILL)
                    finally:
                        os.close(fd)


if __name__ == "__main__":
    try:
        exit_code = main()
    except BaseException:
        try:
            send({"type": "unknown"})
        except BaseException:
            pass
        exit_code = 70
    sys.exit(exit_code)
