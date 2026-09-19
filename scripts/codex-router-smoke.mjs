// Explicit smoke test: creates one test thread and sends one no-tool prompt.
import { CodexRouter } from "../dist/src/codex/router.js";
const command = process.env.CODEX_PATH ?? "codex";
const r = CodexRouter.create(
  { command, args: ["app-server"], turnTimeoutMs: 60000 },
  process.cwd(),
);
let finish;
const done = new Promise((resolve) => {
  finish = resolve;
});
const reply = async (text) => {
  console.log(text);
  if (
    text.includes("CODEX_ROUTER_OK") ||
    text.includes("等待超时") ||
    text.includes("操作失败")
  )
    finish();
};
try {
  await r.handle("smoke", "/acp new", reply);
  await r.handle(
    "smoke",
    "/acp reply Connection test only. Do not use tools or change files. Reply exactly CODEX_ROUTER_OK.",
    reply,
  );
  await done;
  await r.handle("smoke", "/acp recent", reply);
} finally {
  await r.close();
}
