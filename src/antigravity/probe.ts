import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { killAgentAndWait } from "../acp/agent-manager.js";

export interface ProbeOptions {
  command: string;
  args?: string[];
  cwd: string;
  modelId?: string;
  modelConfigId?: string;
  timeoutMs?: number;
  onPromptStart?: (sessionId: string, modelId: string) => Promise<void>;
}

/** Stage A only: no WeChat, no task replay, no automatic authorization. */
export async function probeAntigravity(options: ProbeOptions) {
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000)
    throw Error("invalid_timeout");
  const child = spawn(options.command, options.args ?? ["acp"], {
    cwd: options.cwd, shell: false, stdio: "pipe", detached: process.platform !== "win32",
  });
  // OAuth URLs/codes and provider diagnostics never enter receipts or journal.
  child.stderr.resume();
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () => reject(Error("cli_spawn_failed")));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sessionId = "";
  let response = "";
  let deniedRequests = 0;
  let toolsSeen = 0;
  let currentModel: string | undefined;
  let context: { used: number; size: number } | null = null;
  let sessionCost: { amount: number; currency: string } | null = null;
  let connection: acp.ClientSideConnection;
  const deny = async (): Promise<never> => { deniedRequests++; throw Error("probe_access_denied"); };
  const client: acp.Client = {
    requestPermission: async () => { deniedRequests++; return { outcome: { outcome: "cancelled" } }; },
    readTextFile: deny, writeTextFile: deny, extMethod: deny,
    extNotification: async () => {},
    sessionUpdate: async ({ sessionId: id, update }) => {
      if (id !== sessionId) return;
      if (update.sessionUpdate === "usage_update") {
        if (Number.isFinite(update.used) && update.used >= 0 && Number.isFinite(update.size) && update.size > 0) context = { used: update.used, size: update.size };
        if (update.cost && Number.isFinite(update.cost.amount) && update.cost.amount >= 0 && /^[A-Z]{3}$/.test(update.cost.currency)) sessionCost = { amount: update.cost.amount, currency: update.cost.currency };
      }
      if (update.sessionUpdate === "current_model_update") currentModel = update.currentModelId;
      if (update.sessionUpdate === "config_option_update") {
        const model = update.configOptions.find((o: acp.SessionConfigOption) => o.type === "select" &&
          (options.modelConfigId ? o.id === options.modelConfigId : o.category === "model"));
        if (model?.type === "select") currentModel = model.currentValue;
      }
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        response = (response + update.content.text).slice(0, 256);
      }
      if (update.sessionUpdate === "tool_call") {
        toolsSeen++;
        void connection.cancel({ sessionId }).catch(() => {});
      }
    },
  };
  connection = new acp.ClientSideConnection(() => client,
    acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
  const disconnected = new Promise<never>((_, reject) => {
    child.once("error", () => reject(Error("cli_spawn_failed")));
    void connection.closed.then(() => reject(Error("acp_disconnected")));
  });
  let primaryError: unknown;
  try {
    return await Promise.race([
      disconnected,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("probe_timeout")), timeoutMs); }),
      (async () => {
        const init = await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION,
          clientInfo: { name: "antigravity-stage-a-probe", version: "1.0.0" },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
        const session = await connection.newSession({ cwd: options.cwd, mcpServers: [] });
        sessionId = session.sessionId;
        const selectors = (session.configOptions ?? []).filter((o: acp.SessionConfigOption) => o.type === "select" &&
          (options.modelConfigId ? o.id === options.modelConfigId : o.category === "model"));
        if (selectors.length > 1) throw Error("ambiguous_model_selector");
        const selector = selectors[0];
        const values = selector?.type === "select" ? selector.options.flatMap((o: acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup) => "group" in o ? o.options : [o]) : [];
        const models = selector ? values.map((o: acp.SessionConfigSelectOption) => o.value) : (session.models?.availableModels ?? []).map((o: acp.ModelInfo) => o.modelId);
        const receipt = { at: new Date().toISOString(), stage: "A", loadSession: !!init.agentCapabilities?.loadSession,
          modelConfigId: selector?.id ?? null, availableModelIds: models,
          mode: options.modelId ? "invoke" : "discover", modelId: options.modelId ?? null };
        if (!options.modelId) return { ...receipt, status: "discovered", modelCallVerified: false };
        if (!models.includes(options.modelId)) throw Error("requested_model_not_advertised");
        if (selector) {
          const selected = await connection.setSessionConfigOption({ sessionId, configId: selector.id, value: options.modelId });
          const confirmed = selected.configOptions.find((o: acp.SessionConfigOption) => o.id === selector.id);
          if (confirmed?.type !== "select" || confirmed.currentValue !== options.modelId) throw Error("model_selection_unconfirmed");
          currentModel = confirmed.currentValue;
        } else {
          await connection.unstable_setSessionModel({ sessionId, modelId: options.modelId });
          // Legacy setter acknowledges selection; record this as protocol evidence, not model self-identification.
          currentModel = options.modelId;
        }
        await options.onPromptStart?.(sessionId, options.modelId);
        const promptStartedAt = Date.now();
        const result = await connection.prompt({ sessionId, prompt: [{ type: "text",
          text: "Do not use any tools, read files, or run commands. Reply with exactly ACP_PROBE_OK." }] });
        if (currentModel !== options.modelId) throw Error("model_changed_during_prompt");
        if (deniedRequests || toolsSeen) throw Error("probe_requested_tools");
        if (result.stopReason !== "end_turn" || response.trim() !== "ACP_PROBE_OK") throw Error("probe_response_unconfirmed");
        return { ...receipt, status: "passed", modelCallVerified: true,
          modelSelectionEvidence: selector ? "config_response" : "legacy_setter_ack",
          response: "ACP_PROBE_OK", deniedRequests, toolsSeen,
          usage: { provider: "antigravity", accountingScope: "fresh_session_single_prompt",
            acpPrompts: 1, internalModelRequests: null, durationMs: Date.now() - promptStartedAt,
            tokens: sanitizeTokens(result.usage), context, sessionCost, subscriptionRemaining: null } };
      })(),
    ]);
  } catch (error) {
    primaryError = error; throw error;
  } finally {
    if (timer) clearTimeout(timer);
    try { await killAgentAndWait(child); } catch (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError], `${primaryError instanceof Error ? primaryError.message : "probe_failed"}; cleanup_failed`);
      throw cleanupError;
    }
  }
}

export function sanitizeTokens(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, number> = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens"]) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}
