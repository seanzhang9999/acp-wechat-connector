#!/usr/bin/python3
"""Read the official Antigravity quota panel without sending a model prompt."""
import datetime
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path('/var/lib/awei-quota')
LEDGERS = (
    pathlib.Path('/var/lib/awei-wechat/usage'),
    pathlib.Path('/var/lib/awei-antigravity/usage'),
)
CLI = '/var/lib/awei-antigravity/.local/bin/agy'
WORKSPACE = '/var/lib/awei-antigravity/probe-workspace'


def sample():
    # An isolated terminal gives us rendered text rather than raw redraw sequences.
    socket = f'awei-quota-{os.getpid()}'
    tmux = ['/usr/sbin/runuser', '-u', 'awei-antigravity', '--',
            '/usr/bin/tmux', '-L', socket, '-f', '/dev/null']

    def run(*args):
        return subprocess.check_output(tmux + list(args), text=True, timeout=8)

    try:
        run('new-session', '-d', '-x', '110', '-y', '42', '-c', WORKSPACE,
            CLI, '--sandbox')
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if '? for shortcuts' in run('capture-pane', '-p'):
                break
            time.sleep(0.5)
        else:
            raise RuntimeError('Official CLI prompt unavailable')
        run('send-keys', '-l', '/usage')
        run('send-keys', 'Enter')
        while time.monotonic() < deadline:
            screen = run('capture-pane', '-p')
            if 'CLAUDE AND GPT MODELS' in screen:
                group = screen.split('CLAUDE AND GPT MODELS', 1)[1]
                weekly = re.search(r'Weekly Limit Remaining[^%]*?(\d+\.\d+|\d+)%', group)
                if weekly:
                    refresh = re.search(r'Refreshes in ([^\n]+)', group)
                    five_hour = re.search(r'Five Hour Limit Remaining[^%]*?(\d+\.\d+|\d+)%', group)
                    return {
                        'weeklyRemainingPercent': float(weekly[1]),
                        'weeklyRefreshInDisplayed': refresh[1].strip() if refresh else None,
                        'fiveHourRemainingPercent': float(five_hour[1]) if five_hour else None,
                    }
            time.sleep(0.5)
        raise RuntimeError('Claude/GPT quota panel unavailable')
    finally:
        subprocess.run(tmux + ['kill-server'], capture_output=True, timeout=8, check=False)


def show_table():
    receipts = {}
    for directory in LEDGERS:
        for file in directory.glob('*.json'):
            if re.fullmatch(r'[a-f0-9-]{36}', file.stem):
                receipts[file.stem] = json.loads(file.read_text())
    print('| Official sample (CST) | Call completed (CST) | Task or receipt | Reported tokens | Weekly remaining | Sample type |')
    print('|---|---|---|---:|---:|---|')
    cst = datetime.timezone(datetime.timedelta(hours=8))
    for file in sorted(ROOT.glob('sample-*.json')):
        sample_row = json.loads(file.read_text())
        observed = datetime.datetime.fromisoformat(sample_row['observedAt']).astimezone(cst)
        ids = sample_row['receiptIds']
        kind = 'historical snapshot' if sample_row['historicalBackfill'] else 'batch' if len(ids) > 1 else 'post-call'
        for receipt_id in ids or ['—']:
            receipt = receipts.get(receipt_id, {})
            tokens = ((receipt.get('usage') or {}).get('tokens') or {}).get('totalTokens')
            finished = receipt.get('finishedAt')
            completion = datetime.datetime.fromisoformat(finished).astimezone(cst) if finished else None
            print(f"| {observed:%Y-%m-%d %H:%M:%S} | {completion.strftime('%H:%M:%S') if completion else '—'} | "
                  f"{receipt.get('taskId') or receipt_id} | {tokens if tokens is not None else '—'} | "
                  f"{sample_row['weeklyRemainingPercent']:.2f}% | {kind} |")


def main():
    if '--table' in sys.argv:
        show_table()
        return
    os.umask(0o077)
    ROOT.mkdir(mode=0o700, exist_ok=True)
    observed_ids = set()
    for file in ROOT.glob('sample-*.json'):
        observed_ids.update(json.loads(file.read_text())['receiptIds'])
    started = datetime.datetime.now(datetime.timezone.utc)
    receipts = []
    for directory in LEDGERS:
        for file in directory.glob('*.json'):
            if not re.fullmatch(r'[a-f0-9-]{36}', file.stem) or file.stem in observed_ids:
                continue
            row = json.loads(file.read_text())
            if (row.get('promptStarted') and row.get('finishedAt')
                    and 'opus' in str(row.get('modelId', '')).lower()):
                receipts.append(file.stem)
    if not receipts and '--baseline' not in sys.argv:
        return
    quota = sample()
    now = datetime.datetime.now(datetime.timezone.utc)
    record = dict(quota, observationStartedAt=started.isoformat(), observedAt=now.isoformat(),
                  receiptIds=sorted(receipts), source='official_agy_usage_panel',
                  scope='shared_claude_gpt_pool', historicalBackfill='--baseline' in sys.argv)
    with tempfile.NamedTemporaryFile(mode='w', dir=ROOT, delete=False) as handle:
        json.dump(record, handle)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(handle.name, ROOT / f'sample-{now:%Y%m%dT%H%M%S%fZ}.json')
    print(json.dumps(record))


if __name__ == '__main__':
    main()
