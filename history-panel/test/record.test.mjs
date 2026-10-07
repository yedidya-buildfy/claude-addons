// history-panel/test/record.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSession, promptText } from "../lib/record.mjs";
import { human, reply, result, interrupt, note, slash, stdout, turnEnd, compact, price } from "./fixture.mjs";

const u = (fresh, read, out = 0) => ({ input_tokens: fresh, cache_read_input_tokens: read, cache_creation_input_tokens: 0, output_tokens: out });

test("one entry per human prompt; tool results, meta, wrappers and interrupts are not prompts", () => {
  assert.equal(promptText(human("[Image #1] שלום", 0)), "שלום");
  assert.equal(promptText(interrupt(1)), null);
  assert.equal(promptText({ ...human("x", 0), isMeta: true }), null);
  assert.equal(promptText(human("<local-command-caveat>x</local-command-caveat>", 0)), null);
  assert.equal(promptText(result(1, "t1", "ok")), null);
  assert.equal(promptText(slash("/feedback", "", 2)), null);
  assert.equal(promptText(slash("/design-in-browser", "history panel", 2)), "/design-in-browser history panel");
});

test("cost per entry sums unique assistant messages; context slices chain end to start", () => {
  const lines = [
    human("first", 0), reply(1, { id: "A", usage: u(10, 50_000, 990) }), reply(1, { id: "A", usage: u(10, 50_000, 990) }), turnEnd(2),
    human("second", 3), reply(4, { id: "B", usage: u(0, 80_000, 1000) }), reply(5, { id: "C", usage: u(0, 90_000, 0) }), turnEnd(6),
  ];
  const { entries } = parseSession(lines, { price });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].cost, 1000 / 1e6);                // message A once, not twice
  assert.deepEqual(entries[0].ctx, [0, 50_010]);
  assert.deepEqual(entries[1].ctx, [50_010, 90_000]);       // starts where the first ended
  assert.equal(entries[1].cost, 1000 / 1e6);
  assert.deepEqual(entries[1].tokens, { read: 170_000, fresh: 0, written: 1000 });
  assert.equal(entries[1].running, false);
});

test("last entry without a turn end is running; reply text is kept", () => {
  const { entries } = parseSession([human("go", 0), reply(1, { text: "working on it", stop: "tool_use" })], { price });
  assert.equal(entries[0].running, true);
  assert.deepEqual(entries[0].reply, ["working on it"]);
});

test("sidechain usage does not move the main context", () => {
  const { entries } = parseSession([human("go", 0), reply(1, { usage: u(0, 40_000) }), reply(2, { usage: u(0, 900_000), sidechain: true }), turnEnd(3)], { price });
  assert.equal(entries[0].ctx[1], 40_000);
});

test("interrupt, human mid-turn note, task notification, local slash command", () => {
  const lines = [
    human("go", 0), reply(1, { stop: "tool_use", tools: [["t1", "Bash", { command: "sleep 99", description: "wait" }]] }),
    note("שעברית תתחיל בצד ימין", 2), note("The person enabled mod hot-reloading", 2, null), interrupt(3),
    human("and in the terminal", 4), slash("/feedback", "", 5), stdout("Feedback window opened", 5), reply(6), turnEnd(7),
  ];
  const { entries } = parseSession(lines, { price });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].rows.map((r) => r.kind), ["note", "stop"]);
  assert.equal(entries[0].rows[1].more.find(([k]) => k === "מה כתבת אחרי")[1], "and in the terminal");
  assert.deepEqual(entries[1].rows.map((r) => [r.kind, r.detail]), [["slash", "/feedback"]]);
});

test("compaction adds a row and the next slice starts from the compacted size", () => {
  const lines = [human("a", 0), reply(1, { usage: u(0, 800_000) }), turnEnd(2), compact(3, 800_000, 20_000), human("b", 4), reply(5, { usage: u(0, 30_000) }), turnEnd(6)];
  const { entries } = parseSession(lines, { price });
  assert.deepEqual(entries[1].ctx, [20_000, 30_000]);
  assert.equal(entries[0].rows.at(-1).kind, "compact");
});
