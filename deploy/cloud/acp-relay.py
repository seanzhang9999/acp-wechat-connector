#!/usr/bin/python3
"""ACP stdio relay. EOF or child exit closes the whole process group."""
import os, select, signal, subprocess, sys
p = subprocess.Popen(['/var/lib/awei-antigravity/.local/bin/agy', 'acp', '--sandbox', '--disable-telemetry'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
try:
    done=False
    while not done:
        ready,_,_=select.select([0,p.stdout.fileno()],[],[],1)
        for fd in ready:
            b=os.read(fd,65536)
            if not b:
                done=True;break
            if fd==0:
                p.stdin.write(b);p.stdin.flush()
            else:
                sys.stdout.buffer.write(b);sys.stdout.buffer.flush()
        if p.poll() is not None and not ready: break
except (BrokenPipeError,OSError): pass
finally:
    try: os.killpg(p.pid,signal.SIGTERM)
    except ProcessLookupError: pass
    try: p.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try: os.killpg(p.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        p.wait()
