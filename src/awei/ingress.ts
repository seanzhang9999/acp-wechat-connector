import type { WeixinMessage } from "../weixin/types.js";
export type Ingress = { kind: "assistant" | "business"; text: string; voice: boolean } | { kind: "untranscribed" } | { kind: "unchanged" };
export function aweiIngress(msg: WeixinMessage): Ingress {
  const items = msg.item_list ?? [];
  if (items.length !== 1) return { kind: "unchanged" };
  const item = items[0];
  const voice = item.type === 3;
  if (voice && !item.voice_item?.text?.trim()) return { kind: "untranscribed" };
  const text = voice ? item.voice_item?.text : item.type === 1 ? item.text_item?.text : undefined;
  if (text === undefined) return { kind: "unchanged" };
  const escaped = text.trim().match(/^转给当前会话[：:,，]\s*([\s\S]*)$/);
  if (escaped) return { kind: "business", text: escaped[1], voice };
  // Explicit start-only homophones tolerate speech transcription and omitted punctuation.
  // Keep the original command body; never fuzzy-match arbitrary names or message contents.
  const match = text.trim().match(/^[阿啊AaＡａ]\s*[维維唯惟威微薇伟偉韦韋玮瑋炜煒为為围圍卫衛魏蔚][：:,，、。.!！?？\s]*([\s\S]*)$/);
  if (match) return { kind: "assistant", text: (match[1] ?? "").trim(), voice };
  return voice ? { kind: "business", text, voice } : { kind: "unchanged" };
}
