// history-panel/test/summarize.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeBatch, parseAnswer } from "../lib/summarize.mjs";

test("batch asks once and maps answers by uuid; titles fit in 28 chars", async () => {
  let calls = 0;
  const ask = async (messages) => {
    calls++;
    assert.match(messages[1].content, /#1[\s\S]*תדחוף/);
    return JSON.stringify([{ n: 1, title: "דחיפה למאגר התוספים וגם עוד הרבה מילים", asked: "לדחוף.", happened: "נדחף." }]);
  };
  const out = await summarizeBatch([{ uuid: "u1", prompt: "תדחוף", reply: ["נדחף."], rows: [{ what: "נדחף ל‑master", detail: "b" }] }], ask);
  assert.equal(calls, 1);
  assert.ok([...out.u1.title].length <= 28 && "דחיפה למאגר התוספים וגם עוד הרבה מילים".startsWith(out.u1.title + " "));
  assert.equal(out.u1.happened, "נדחף.");
});

test("answer parser accepts fenced JSON and rejects junk", () => {
  assert.deepEqual(parseAnswer('```json\n[{"n":1,"title":"a","asked":"b","happened":"c"}]\n```'), [{ n: 1, title: "a", asked: "b", happened: "c" }]);
  assert.equal(parseAnswer("sorry"), null);
});

test("a long title is cut at a word, not inside one", async () => {
  const ask = async () => JSON.stringify([{ n: 1, title: "תכנון היסטוריית שיחות ועלויות לכל הודעה", asked: "a", happened: "b" }]);
  const out = await summarizeBatch([{ uuid: "u1", prompt: "x", reply: [], rows: [] }], ask);
  assert.equal(out.u1.title, "תכנון היסטוריית שיחות");
});
