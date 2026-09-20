import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
/** Transfer tickets let the write-lease holder hand the bridge to another session without waiting for a release.
 * Stored in the shared state dir (local same-user trust model, same as the lock owner JSON). Single-use, short TTL. */
export interface TransferTicket { code: string; issuedAt: string; expiresAt: string; issuedBy: string }
const TTL_MS = 10 * 60 * 1000;
const ALPHABET = "ACDEFGHJKLMNPQRSTUVWXYZ2345679"; // no easily confused glyphs
function file(dir: string) { return path.join(dir, "transfer.json"); }
export function issueTransfer(dir: string, issuedBy: string): TransferTicket {
  let code = "";
  for (let i = 0; i < 6; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  const ticket: TransferTicket = { code, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + TTL_MS).toISOString(), issuedBy };
  writeFileSync(file(dir) + ".tmp", JSON.stringify(ticket), { mode: 0o600 });
  renameSync(file(dir) + ".tmp", file(dir));
  return ticket;
}
export function readTransfer(dir: string): TransferTicket | null {
  if (!existsSync(file(dir))) return null;
  try {
    const raw = JSON.parse(readFileSync(file(dir), "utf8")) as TransferTicket;
    return typeof raw.code === "string" && raw.code.length === 6 && Number.isFinite(Date.parse(raw.expiresAt)) ? raw : null;
  } catch { return null; }
}
export function checkTransfer(dir: string, code: string): { ok: true; ticket: TransferTicket } | { ok: false; detail: string } {
  const ticket = readTransfer(dir);
  if (!ticket) return { ok: false, detail: "没有待使用的转移码；请让持有写权限的会话先生成。" };
  if (Date.parse(ticket.expiresAt) < Date.now()) return { ok: false, detail: `转移码已过期（有效期至 ${ticket.expiresAt}）；请让持有会话重新生成。` };
  if (ticket.code !== code.trim().toUpperCase()) return { ok: false, detail: "转移码不正确，未做任何变更。" };
  return { ok: true, ticket };
}
export function consumeTransfer(dir: string): void { if (existsSync(file(dir))) unlinkSync(file(dir)); }
