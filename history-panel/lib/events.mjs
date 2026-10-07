// history-panel/lib/events.mjs
// Technical rows: facts read from what Claude ran and what came back. Never a model.
export const first = (s) => String(s || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
export const clip = (s, n = 60) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
export const toolLabel = (call) => call ? `${call.name}: ${clip(first(call.input.description || call.input.command || call.input.file_path || call.input.url || call.input.query || call.input.prompt), 50)}` : "—";

export function rowFromNote(att, at, lastCall) {
  const p = att.prompt;
  const text = (typeof p === "string" ? p : (p || []).filter((x) => x.type === "text").map((x) => x.text).join("\n")).replace(/\[Image #\d+\]\s*/g, "").trim();
  const more = [["כתבת", text]];
  if (att.imagePasteIds) more.push(["צירפת", "צילום מסך"]);
  more.push(["מה רץ באותו רגע", toolLabel(lastCall)]);
  return { kind: "note", at, what: "הוספת הכוונה באמצע", detail: `״${clip(text, 40)}״`, more };
}
export function rowFromStop(at, lastCall, nextPrompt) {
  return { kind: "stop", at, what: "עצרת את העבודה", detail: "Esc", more: [["מה נעצר", toolLabel(lastCall)], ["מה כתבת אחרי", nextPrompt || "—"]] };
}
export function rowFromSlash(name, args, out, at) {
  if (name === "/btw") return { kind: "btw", at, what: "שאלה צדדית (/btw)", detail: `״${clip(args, 40)}״`, more: [["שאלת", args], ["התשובה", out || "—"]] };
  return { kind: "slash", at, what: "פקודה", detail: name, more: [["פקודה", `${name}${args ? " " + args : ""}`], ["תוצאה", first(out) || "—"]] };
}
export function rowFromCompact(d) {
  const m = d.compactMetadata || {};
  const k = (n) => `${Math.round((n || 0) / 1000)}K`;
  return { kind: "compact", at: d.timestamp, what: "הקונטקסט נדחס", detail: `${k(m.preTokens)} → ${k(m.postTokens)}`, more: [["לפני", k(m.preTokens)], ["אחרי", k(m.postTokens)], ["סוג", m.trigger === "manual" ? "ידני (/compact)" : "אוטומטי"]] };
}
export function rowsFromTool() { return []; }          // Tasks 2–3
export function foldPushRetries(rows) { return rows; } // Task 2
