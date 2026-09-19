# Codex task routing from WeChat

This opt-in extension intercepts `/acp` commands before the ACP agent. It uses one persistent Codex App Server connection for listing, reading and continuing tasks. It does not copy conversations, fork on errors, scrape the desktop UI, or modify the Codex database.

## Configure

Add this block to the existing bridge JSON configuration:

```json
{
  "codexServer": {
    "command": "/absolute/path/to/codex",
    "args": ["app-server"],
    "requestTimeoutMs": 30000,
    "turnTimeoutMs": 600000
  }
}
```

To connect to an existing server that explicitly exposes a compatible local control socket, use `args: ["app-server", "proxy", "--sock", "/absolute/path/to/socket"]` with a Codex version that supports the proxy subcommand. No socket discovery, desktop restart, daemon installation, or automatic fallback is performed. The command is spawned directly, without a shell. Use a Codex executable compatible with the existing configuration.

The standalone `app-server` mode can see stored tasks, but cannot take over tasks owned by another server (`active writer`). Connecting to the actual owner through its supported transport is required in that case. A readable history is not proof that a task is writable. Do not retry or fork to hide this error.

Only the user identified by the WeChat QR login may use these commands or selected-task routing. Login responses without an owner ID cannot enable routing. With no `codexServer`, `/acp` responds with a configuration error and never falls through to the model.

## Commands

- `/acp` or `/acp help`: show help.
- `/acp list [search terms]`: list ten recent matching tasks using `thread/list`.
- `/acp more`: next page. Numbers refer only to the most recent page shown to that user.
- `/acp use <number|full UUID>`: select a target without resuming or starting it.
- `/acp current`: show the selected target.
- `/acp recent [number|full UUID]`: show up to six recent user/assistant text messages, with a bounded output size. Does not show reasoning or tool output. Uses `thread/read` without resuming. For server versions without history pagination this may require reading the full history into the bridge; output is bounded but retrieval is not paginated.
- `/acp reply <text>`: send text to the selected task.
- `/acp send <number|full UUID> <text>`: send to an explicit target without changing selection.
- `/acp result`: show the latest bridge request status/result for this user.
- `/acp new`: create and select a new task in the configured project directory.
- `/acp off`: return to the original ACP session; this does **not** release a writer lock.
- `/acp codex quit`: macOS only, request a normal quit of the Codex desktop App used by the configured bundled binary. Owner-only; no target selection required. Checks main-process and desktop App Server exit before reporting success. Does not force-kill or close bridge-owned services. Desktop work may be interrupted; busy-state refusal is not implemented because no supported desktop status connection is available.
- `/acp release-all` (alias `/acp release all`): release all sessions held by the bridge, including the original ACP session. Refuses while there are active/queued tasks, approvals, attachment deliveries or unsent message buffers. Keeps history and the persisted ACP session ID; clears target selection. Connections reconnect lazily on later messages.

When a task is selected, ordinary text and attachments go to that task. Otherwise existing ACP behavior is preserved. Existing `/acp-config`, `/acp-cancel`, `/acp-new`, etc. remain commands for the original ACP session, not the selected App Server task. Mixed messages preserve all text and media items in wire order. Images are saved and sent through `localImage`; files (including text files), videos and untranscribed voice files are saved to the inbox, with their exact local paths supplied as text input. Voice transcription is forwarded as text. Any download/save failure aborts the entire turn rather than sending an incomplete request. A local path does not override the selected task's sandbox permissions.

Selections, list snapshots and request results are in memory and reset when the bridge restarts. Existing upstream ACP session persistence is separate. Keep the process running while waiting for a response.

## Execution and results

The router resumes an existing task on its connection and calls `turn/start`. New tasks created on that connection can receive their first turn without resume (they may not yet have a rollout). Busy targets are rejected, not interrupted or steered. Only one outstanding bridge request per target is accepted.

Results are correlated with both `threadId` and `turnId`. Completed assistant items are collected even when `turn/completed` contains an empty item list. Switching targets does not reroute earlier replies. Unknown `/acp` commands are errors, never model prompts. No send is retried automatically; a timeout/disconnection can mean uncertain delivery, so inspect history before resending.

Server requests for approval or dynamic tools are not automatically approved or answered by the router. The user is notified to use the originating client where available. A standalone server with no approval-capable client can remain waiting; this router is not an approval UI. Full mirroring of independently initiated desktop turns is not implemented.

WeChat send acceptance does not prove phone receipt. iLink context expiry and send limits still apply. `/acp result` on a fresh incoming message can retrieve the retained latest result.

## Validate

```sh
npm ci
npm run build
npm test
# Optional real model smoke test: creates ONE test task and sends ONE no-tool prompt.
CODEX_PATH=/absolute/path/to/codex node scripts/codex-router-smoke.mjs
```

The smoke test validates new task creation, sending, exact-turn response capture and recent text reads. Tests also cover owner-only dispatch, command interception, numbering isolation, target switching, early completion events, conflicting writers, timeout without resend, and a selection/message arrival race.

## Bidirectional attachments

Incoming attachments use the existing encrypted WeChat CDN download and private, collision-safe inbox storage (0700 directory / 0600 files). Original bytes and filenames are retained safely; path traversal in filenames cannot choose the save directory. Limit: 25 MiB per attachment. The existing ACP path remains available through `/acp off`.

For outgoing attachments, ask the target task to return a file or image. The bridge adds delivery instructions to the turn: save the deliverable inside the target task's working directory and include `[filename](<absolute path>)` or `![image](<absolute path>)` in the final answer. The bridge reads explicit local Markdown links, then reuses WeChat's encrypted file/image upload and send path. Common raster images are sent as image messages; other files are sent as file messages. Files outside the target workspace (including escaping symlinks), missing files, and files over 25 MiB produce an explicit failure notice. Up to ten unique attachments per turn. Code fences, inline code, remote links and source references ending in `:line` are not attachment requests.

Only the exact bridge-initiated turn's final answer is scanned. Switching the selected task does not redirect an earlier result. Independently initiated desktop turns are not mirrored. Sending a local-path text reference into a task is distinct from the model actually reading that file; the live WeChat phone receipt still requires end-to-end validation.

## Release implementation and desktop handoff research (2026-09-19)

Tested against bundled `codex-cli 0.155.0-alpha.9`. The installed protocol exposes `thread/unsubscribe` with only `{threadId}`. It affects the requesting connection. The [official App Server documentation](https://developers.openai.com/zh-Hans/docs/app-server) describes a 30-minute idle/no-subscriber grace period before unloading. Unsubscribe is not a reliable immediate writer-lock handoff.

`release-all` first checks ACP lifecycle/queue state and the router's flights, approvals and attachment delivery. It enumerates all loaded threads in the bridge's server (including threads outside the selected target), reads their current status, and refuses any active or uncertain status. It then shuts down the owned idle ACP process tree and resets the bridge-owned App Server, waiting for process exit before reporting success. Failed ACP cleanup is retained for retry. It never removes history, archives tasks, cancels active turns or signals desktop processes. If one backend closes and the other fails its recheck/cleanup, it reports incomplete release; retry once the cause is resolved. Proxy/daemon configurations cannot claim release by merely terminating a proxy and are rejected by reset.

The running desktop server uses its own stdio transport. Read-only inspection found no TCP listener or named control socket exposed by that process. No public request in this installed protocol provides immediate unload or disconnect of another client's selected thread. Therefore the bridge currently cannot tell the desktop App Server to release one task immediately. A supported desktop-side cooperation interface, or a deliberately shared App Server connection, would be needed. Sharing one server avoids cross-server writer conflicts but still needs active-turn/approval coordination. Archiving/deleting a thread or killing the desktop server is not used as a substitute.

Validated locally: an isolated real server test creates a test thread in temporary CODEX_HOME, observes a second server fail on its active writer lock, invokes release-all, resumes the same thread from the second server, and reconnects the first transport. No production history or model turns are used:

```sh
CODEX_PATH=/absolute/path/to/codex node scripts/codex-release-smoke.mjs
```

Unit/integration tests cover mixed attachment ordering and exact bytes, download failure, local link extraction, outgoing path constraints, owner-only command dispatch, busy/approval release guards, original-target attachment correlation, and ACP persistence during release. Existing WeChat upload/send tests run with network mocks. A real phone send/receive has not been simulated or claimed.

## Personal remote/local handoff

From WeChat, send `/acp codex quit` to normally exit the desktop App, then wait for the verified success reply. Continue the original task with `/acp list`, `/acp use <number>`, and a message or attachment. On returning to the computer, first send `/acp release-all` and wait for success, then reopen Codex desktop.

The quit command is handled by the bridge itself, not sent to a model. It verifies the configured app bundle ID is `com.openai.codex`, selects only its desktop main process, requests normal quit through macOS NSRunningApplication, and monitors the desktop's App Server PIDs even if they become orphaned. It refuses if the bridge is still a descendant of the desktop process. A rejected quit, a confirmation dialog, a remaining server or a restarted desktop causes a failure/timeout reply; no force termination follows. If the desktop is already absent, it does not launch it and does not claim that unrelated service locks have been released. Current-process status is read through public OS APIs, without inspecting conversation contents.

The acknowledgement is sent before quitting; if acknowledgement delivery fails, quit is not attempted. Tests replace OS quit and process snapshots, covering owner checks, invalid arguments, bridge preservation, orphan servers, respawn, timeout, rejected quit and an already stopped desktop. The live Codex desktop was intentionally not quit during deployment; real remote exit remains a user-initiated acceptance step.
