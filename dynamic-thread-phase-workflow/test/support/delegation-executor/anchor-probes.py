"""Deterministic probes through production main: NO actual forks or signals.
Semantic syscall hooks inject loss BEFORE its final check, except the explicitly
named in-flight cases. These are control-flow checks, not OS latency/identity proof.
"""
import importlib.util
import io
import json
import sys
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("anchor", sys.argv[1])
anchor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(anchor)


def run(case):
    output, signals, opened, closed = [], [], [], []
    clock, polls, waits, launches = 0.0, 0, 0, 0
    lost, expired, direct, term_at = False, False, False, None
    many = case.startswith("many-") or case.startswith("inflight-")
    pids = list(range(1000, 5096)) if many else [20]
    killed, reaped = set(), set()
    config = b'{"type":"dispatch","argv":["never-executed"],"graceMs":1}\n'
    wire = [(0, config)]
    if case in ("queued-revoke", "queued-revoke-split"):
        frames = b'{"type":"term"}\n{"type":"revoke"}\n'
        wire = [(0, config + frames)] if case == "queued-revoke" else [(0, config), (0, frames)]
    elif case in ("term-eof", "term-budget", "empty-budget"):
        wire = [(0, b'{"type":"term"}\n')]
    elif case == "fragmented":
        wire = [(0, config[:7]), (0.04, config[7:-1]), (0.06, config[-1:])]
    elif case == "fragmented-revoke":
        wire = [(0, b'{"type":"term"}\n{"type":"re'), (0, b'voke"}\n')]
    elif case == "duplicate-dispatch":
        wire = [(0, config + config)]
    elif case == "invalid-frame":
        wire = [(0, b'{"type":"term"}\n{"type":"bogus"}\n')]
    elif case == "invalid-json":
        wire = [(0, b'{"type":"term"}\n{\n')]
    elif case == "invalid-argv":
        wire = [(0, config.replace(b'["never-executed"]', b'[42]'))]
    elif case == "partial-overflow":
        wire = [(0, b'x' * 65536), (0.04, b'x')]
    elif case == "control-flood":
        wire = [(0, b' ') for _ in range(5)]

    def lose(kind="eof"):
        nonlocal lost, expired, clock
        if kind == "budget":
            expired = True
            clock = (term_at if term_at is not None else 0) + anchor.SHUTDOWN + 1
        else:
            lost = True
            wire.append((clock, b'{"type":"revoke"}\n' if kind == "revoke" else b''))

    def ready(readers, writers, errors, timeout):
        nonlocal clock, polls
        polls += 1
        assert polls < 100000, "bounded probe stalled"
        clock += timeout
        available = wire and wire[0][0] <= clock
        if not available and polls == (3 if case == "term-budget" else 2) and case in ("dispatch-eof", "term-eof", "term-budget"):
            # First collected batch ended; loss is pending before the action's
            # separate final check, not fabricated inside its signal syscall.
            lose("budget" if case == "term-budget" else "eof")
        return ([3] if available else [], [], [])

    def read(fd, size):
        assert fd == 3 and 0 < size <= 65537
        _, data = wire.pop(0)
        assert len(data) <= size
        return data

    def wait(*_):
        nonlocal waits, direct
        waits += 1
        if case == "wait-error":
            raise OSError("not ECHILD")
        if not direct and launches:
            direct = True
            if case == "reap-eof":
                lose()
            return (10, 0)
        if case.startswith("empty-"):
            lose("budget" if case == "empty-budget" else "eof")
            raise ChildProcessError()
        if case == "reap-many-eof" and waits <= 101:
            if waits == 100:
                lose()
            return (6000 + waits, 0)
        dead = killed - reaped
        if dead:
            pid = min(dead)
            reaped.add(pid)
            return (pid, 0)
        if len(reaped) == len(pids):
            raise ChildProcessError()
        return (0, 0)

    def pidfd(pid):
        nonlocal clock
        if pid != 100:
            if case == "pidfd-error":
                raise OSError("pidfd unavailable")
            if case in ("many-eof", "many-revoke", "pidfd-budget") and pid == pids[0]:
                lose({"many-eof": "eof", "many-revoke": "revoke", "pidfd-budget": "budget"}[case])
            if case == "many-mid-eof" and pid == pids[2048]:
                lose()
            if case == "many-budget":
                clock += 0.004
            if case == "duplicate-during-kill" and pid == pids[0]:
                wire.append((clock, config))
        fd = pid + 10000
        opened.append(fd)
        return fd

    def group(pid):
        if case in ("getpgid-eof", "getpgid-budget"):
            lose("budget" if case.endswith("budget") else "eof")
        if case == "getpgid-error":
            raise PermissionError()
        return 999 if case == "foreign-group" else 100

    def record(target, sig):
        nonlocal term_at
        if sig == 0:
            if case == "pidfd-unsupported":
                raise OSError("unsupported")
            return
        if sig == anchor.signal.SIGTERM:
            assert target == 0
            term_at = clock
            if case == "inflight-term":
                lose()
        else:
            assert target - 10000 in pids and target in opened and target not in closed
            if case in ("inflight-kill", "inflight-budget") and not killed:
                # Deliberately AFTER check() returned, at syscall entry: the
                # approved single-in-flight-operation race, not a safety defect.
                lose("budget" if case == "inflight-budget" else "eof")
            killed.add(target - 10000)
        signals.append((target, sig, lost, clock))
        if case == "eperm" and sig == anchor.signal.SIGKILL:
            raise PermissionError()

    def children(*_):
        if case == "proc-inaccessible":
            raise PermissionError()
        if case in ("inventory-eof", "inventory-budget"):
            lose("budget" if case.endswith("budget") else "eof")
        return io.BytesIO(b' '.join(str(pid).encode() for pid in pids))

    def emit(event):
        output.append(event)
        if event["type"] == "residual" and case in ("residual-eof", "residual-revoke"):
            lose("revoke" if case.endswith("revoke") else "eof")

    def popen(*args, **kwargs):
        nonlocal launches
        assert not lost and not expired
        launches += 1
        assert launches == 1 and args[0] == ["never-executed"] and kwargs == {"close_fds": True}
        return SimpleNamespace(pid=10, returncode=None)

    with patch.multiple(anchor.os, getpid=lambda: 100, getpgrp=lambda: 100,
                        getpgid=group, pidfd_open=pidfd, close=closed.append,
                        read=read, waitpid=wait, kill=record), \
         patch.object(anchor.ctypes, "CDLL", lambda *a, **kw: SimpleNamespace(prctl=lambda *a: 0)), \
         patch.object(anchor.signal, "pidfd_send_signal", record), \
         patch.object(anchor.signal, "signal", lambda *a: None), \
         patch.object(anchor.subprocess, "Popen", popen), \
         patch.object(anchor.select, "select", ready), \
         patch.object(anchor.time, "monotonic", lambda: clock), \
         patch.object(anchor, "send", emit), patch("builtins.open", children):
        try:
            result = anchor.main()
        except (RuntimeError, OSError, ValueError) as error:
            result = str(error) or type(error).__name__
    assert sorted(opened) == sorted(closed), (case, opened, closed)
    kills = [s for s in signals if s[1] == anchor.signal.SIGKILL]
    late = [s for s in signals if s[2] or term_at is not None and s[3] - term_at >= anchor.SHUTDOWN]
    if case in ("drained", "fragmented"):
        assert result == 0 and output[-1] == {"type": "empty"}
        assert len(kills) == 1 and len(signals) == 2
    else:
        assert result != 0 and {"type": "empty"} not in output, (case, result, output)
    if case.startswith("inflight-"):
        assert len(late) == 1, (case, signals)
        assert len(kills) == (0 if case == "inflight-term" else 1)
    else:
        assert not late, (case, late[:3])
        expected = 2048 if case == "many-mid-eof" else 1 if case in ("drained", "fragmented", "eperm") else 0
        if case == "many-budget":
            assert 1 < len(kills) < 2500 and clock - term_at >= anchor.SHUTDOWN
        else:
            assert len(kills) == expected, (case, len(kills), result)
    if case in ("queued-revoke", "queued-revoke-split", "fragmented-revoke", "dispatch-eof", "term-eof", "term-budget",
                "duplicate-dispatch", "invalid-frame", "invalid-json", "invalid-argv", "partial-overflow", "control-flood"):
        assert not signals and launches == 0, (case, signals, launches)
    if case in ("residual-eof", "residual-revoke", "reap-eof", "reap-many-eof", "empty-eof"):
        assert not signals, (case, signals)
    if case.endswith("budget"):
        assert result == "shutdown deadline", (case, result)
    if case == "reap-many-eof":
        assert waits == 100
    print(json.dumps({"case": case, "result": result, "signals": len(signals), "kills": len(kills),
                      "inFlightAfterFinalCheck": len(late), "mockChildren": len(pids), "check": "PASS"}))


cases = ["drained", "fragmented", "many-eof", "many-revoke", "many-mid-eof", "many-budget",
         "pidfd-budget", "getpgid-eof", "getpgid-budget", "queued-revoke", "queued-revoke-split",
         "fragmented-revoke", "residual-eof", "residual-revoke", "dispatch-eof", "term-eof", "term-budget",
         "empty-eof", "empty-budget", "reap-eof", "reap-many-eof", "inventory-eof", "inventory-budget",
         "inflight-kill", "inflight-term", "inflight-budget", "foreign-group", "proc-inaccessible",
         "eperm", "pidfd-unsupported", "pidfd-error", "getpgid-error", "wait-error", "duplicate-dispatch",
         "duplicate-during-kill", "invalid-frame", "invalid-json", "invalid-argv", "partial-overflow", "control-flood"]
for case in cases:
    run(case)
