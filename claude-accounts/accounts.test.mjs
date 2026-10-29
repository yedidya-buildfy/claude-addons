import assert from "node:assert/strict";
import { test } from "node:test";
import { keepChoice, priceOf, recommend } from "./accounts.mjs";
import { planName, withAccount } from "./claude.mjs";
import { pickWindows } from "./gemini.mjs";
import { jwtClaims } from "./store.mjs";

test("Claude plan name from the rate tier, else the subscription", () => {
  assert.equal(planName({ rateLimitTier: "default_claude_max_20x", subscriptionType: "max" }), "Max 20x");
  assert.equal(planName({ subscriptionType: "pro" }), "Pro");
  assert.equal(planName(undefined), "");
});

test("price by tool and plan; unknown plan has none", () => {
  assert.equal(priceOf("claude", "Max 20x"), 200);
  assert.equal(priceOf("codex", "Pro"), 200);
  assert.equal(priceOf("gemini", "Pro"), 20);
  assert.equal(priceOf("codex", "Enterprise"), null);
});

test("recommends, per tool, the account with the most room in its busier window", () => {
  const r = (provider, email, five, week, extra = {}) => ({ provider, email, windows: [{ pct: five }, { pct: week }], ...extra });
  assert.deepEqual(recommend([r("claude", "a", 10, 80), r("claude", "b", 50, 20), r("codex", "c", 0, 90)]), { claude: "b", codex: "c" });
  assert.deepEqual(recommend([r("claude", "a", 100, 0), r("claude", "b", 90, 90)]), { claude: "b" }); // full rules it out
  assert.deepEqual(recommend([r("claude", "a", 30, 30), r("claude", "b", 30, 30, { active: true })]), { claude: "b" }); // tie → stay
  assert.deepEqual(recommend([r("claude", "a", 10, 10, { error: "signed out" })]), {});
});

test("switching Claude swaps only its login and keeps MCP logins", () => {
  const blob = { mcpOAuth: { x: 1 }, claudeAiOauth: { accessToken: "old" } };
  assert.deepEqual(withAccount(blob, { accessToken: "new" }), { mcpOAuth: { x: 1 }, claudeAiOauth: { accessToken: "new" } });
});

test("Gemini shows its main 5h and weekly windows, not the per-model extras", () => {
  const w = [
    { id: "3p-5h", label: "5h", usedPercent: 0 },
    { id: "gemini-5h", label: "5h", usedPercent: 6, resetsAt: 1 },
    { id: "gemini-argon-wtu-weekly", label: "wk", usedPercent: 100 },
    { id: "gemini-weekly", label: "wk", usedPercent: 5, resetsAt: 2 },
  ];
  assert.deepEqual(pickWindows(w), [{ label: "5h", pct: 6, resets: 1 }, { label: "wk", pct: 5, resets: 2 }]);
});

test("reads a JWT's claims; junk gives {}", () => {
  const jwt = `x.${Buffer.from(JSON.stringify({ email: "a@b" })).toString("base64url")}.y`;
  assert.equal(jwtClaims(jwt).email, "a@b");
  assert.deepEqual(jwtClaims("nope"), {});
});

test("a Keychain value printed as hex (non-ASCII inside) reads back as the original text", async () => {
  const { readItem } = await import("./store.mjs");
  const svc = `claude-accounts-selftest-${process.pid}`;
  const { execFileSync } = await import("node:child_process");
  const text = JSON.stringify({ name: "ידידיה" });
  execFileSync("security", ["add-generic-password", "-U", "-a", "t", "-s", svc, "-X", Buffer.from(text).toString("hex")]);
  try {
    assert.equal(readItem(svc, "t"), text);
  } finally {
    execFileSync("security", ["delete-generic-password", "-a", "t", "-s", svc], { stdio: "ignore" });
  }
});

test("the owner's pick survives an old login written back; a new sign-in becomes the pick", () => {
  assert.equal(keepChoice("b", "a", true), "restore"); // an open session put a known account back
  assert.equal(keepChoice("b", "c", false), "accept"); // a brand-new account was signed in
  assert.equal(keepChoice("b", "b", true), "accept");
  assert.equal(keepChoice(null, "a", true), "accept"); // sign-in under way, or never picked
  assert.equal(keepChoice(undefined, "a", true), "accept");
});
