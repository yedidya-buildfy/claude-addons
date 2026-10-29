import assert from "node:assert/strict";
import { test } from "node:test";
import { planName, recommend, withAccount } from "./accounts.mjs";

test("plan name from the rate tier, else the subscription", () => {
  assert.equal(planName({ rateLimitTier: "default_claude_max_20x", subscriptionType: "max" }), "Max 20x");
  assert.equal(planName({ subscriptionType: "pro" }), "Pro");
  assert.equal(planName(undefined), "");
});

test("recommends the account with the most room in its busier window", () => {
  const acc = (email, five, week, extra = {}) => ({ email, five: { pct: five }, week: { pct: week }, ...extra });
  assert.equal(recommend([acc("a", 10, 80), acc("b", 50, 20)]), "b");
  assert.equal(recommend([acc("a", 100, 0), acc("b", 90, 90)]), "b"); // a full window rules it out
  assert.equal(recommend([acc("a", 30, 30), acc("b", 30, 30, { active: true })]), "b"); // tie → stay
  assert.equal(recommend([acc("a", 10, 10, { error: "signed out" })]), null);
});

test("switching swaps only the Claude login and keeps MCP logins", () => {
  const blob = { mcpOAuth: { x: 1 }, claudeAiOauth: { accessToken: "old" } };
  assert.deepEqual(withAccount(blob, { accessToken: "new" }), { mcpOAuth: { x: 1 }, claudeAiOauth: { accessToken: "new" } });
});
