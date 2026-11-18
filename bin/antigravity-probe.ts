#!/usr/bin/env node
import { probeAntigravity } from "../src/antigravity/probe.js";

// Discovery is the default. Setting AGY_MODEL_ID explicitly enables one model call.
try {
  const result = await probeAntigravity({ command: process.env.AGY_BIN || "agy",
    cwd: process.env.AGY_PROBE_CWD || process.cwd(), modelId: process.env.AGY_MODEL_ID || undefined,
    modelConfigId: process.env.AGY_MODEL_CONFIG_ID || undefined,
    timeoutMs: Number(process.env.AGY_PROBE_TIMEOUT_MS || 90_000) });
  console.log(JSON.stringify(result));
} catch (error) {
  const known = new Set(["invalid_timeout", "cli_spawn_failed", "acp_disconnected", "probe_timeout",
    "ambiguous_model_selector", "requested_model_not_advertised", "model_selection_unconfirmed",
    "model_changed_during_prompt", "probe_requested_tools", "probe_response_unconfirmed"]);
  const code = error instanceof Error && known.has(error.message) ? error.message : "acp_probe_failed";
  console.log(JSON.stringify({ at: new Date().toISOString(), stage: "A", status: "failed", code,
    modelCallVerified: false }));
  process.exitCode = 1;
}
