// history-panel/test/fixture.mjs
// Builds small session records line by line, shaped like Claude Code's JSONL.
let n = 0;
const ts = (min) => new Date(Date.UTC(2026, 9, 7, 16, min)).toISOString();
export const human = (text, min) => ({ type: "user", uuid: `u${++n}`, timestamp: ts(min), cwd: "/r/app", message: { role: "user", content: text } });
export const reply = (min, { id = `m${++n}`, text = "", tools = [], usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }, model = "claude-opus-5-5", stop = "end_turn", sidechain = false } = {}) => ({
  type: "assistant", uuid: `a${++n}`, timestamp: ts(min), cwd: "/r/app", isSidechain: sidechain,
  message: { id, model, stop_reason: stop, usage, content: [...(text ? [{ type: "text", text }] : []), ...tools.map(([tid, name, input]) => ({ type: "tool_use", id: tid, name, input }))] },
});
export const result = (min, tid, out, { isError = false, toolUseResult = { stdout: out, stderr: "" } } = {}) => ({
  type: "user", uuid: `r${++n}`, timestamp: ts(min), cwd: "/r/app", toolUseResult,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, is_error: isError, content: out }] },
});
export const interrupt = (min) => ({ type: "user", uuid: `i${++n}`, timestamp: ts(min), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });
export const note = (text, min, origin = { kind: "human" }) => ({ type: "attachment", uuid: `q${++n}`, timestamp: ts(min), attachment: { type: "queued_command", prompt: text, commandMode: origin ? "prompt" : "task-notification", ...(origin ? { origin } : {}) } });
export const slash = (name, args, min) => ({ type: "user", uuid: `s${++n}`, timestamp: ts(min), message: { role: "user", content: `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args>${args}</command-args>` } });
export const stdout = (out, min) => ({ type: "user", uuid: `o${++n}`, timestamp: ts(min), message: { role: "user", content: `<local-command-stdout>${out}</local-command-stdout>` } });
export const turnEnd = (min) => ({ type: "system", subtype: "turn_duration", timestamp: ts(min) });
export const compact = (min, pre, post) => ({ type: "system", subtype: "compact_boundary", timestamp: ts(min), compactMetadata: { preTokens: pre, postTokens: post } });
export const price = (model, u) => ((u.input_tokens || 0) + (u.output_tokens || 0)) / 1e6; // $1 per M, for readable expectations
