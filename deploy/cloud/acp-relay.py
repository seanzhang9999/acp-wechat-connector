#!/usr/bin/python3
"""ACP stdio relay. EOF closes the whole executor process group, not just its pipe."""
import os, signal, subprocess, sys, threading, time
p = subprocess.Popen(['/var/lib/awei-antigravity/.local/bin/agy', 'acp', '--sandbox', '--disable-telemetry'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
def output():
    try:
        while True:
            b=os.read(p.stdout.fileno(),65536)
            if not b: break
            sys.stdout.buffer.write(b); sys.stdout.buffer.flush()
    except (BrokenPipeError,OSError): pass
    finally:
        try: os.close(0)
        except OSError: pass
threading.Thread(target=output,daemon=True).start()
try:
    while p.poll() is None:
        b=os.read(0,65536)
        if not b: break
        p.stdin.write(b);p.stdin.flush()
except (BrokenPipeError,OSError): pass
finally:
    try: os.killpg(p.pid,signal.SIGTERM)
    except ProcessLookupError: pass
    try: p.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try: os.killpg(p.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        p.wait()
