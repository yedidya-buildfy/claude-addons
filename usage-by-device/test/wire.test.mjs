import { test } from "node:test";
import assert from "node:assert/strict";
import { derive, seal, unseal, sealDevice, MAX_BODY } from "../wire.mjs";

const acct = { accountUuid: "aaaa-1", organizationUuid: "org-1" };

test("same subscription → same channel and key; another → different", () => {
  const a = derive(acct), b = derive({ ...acct }), c = derive({ accountUuid: "zzz", organizationUuid: "org-1" });
  assert.equal(a.topic, b.topic);
  assert.match(a.topic, /^ubd_[0-9a-f]{40}$/);
  assert.notEqual(a.topic, c.topic);
  assert.ok(a.key.equals(b.key));
  assert.equal(derive(undefined), null);
  assert.equal(derive({ accountUuid: "x" }), null);
});

test("seal/unseal round trip; wrong key or garbage → null", () => {
  const { key } = derive(acct);
  const s = seal(key, { kind: "x", n: 1 });
  assert.deepEqual(unseal(key, s), { kind: "x", n: 1 });
  assert.equal(unseal(derive({ accountUuid: "zzz", organizationUuid: "o" }).key, s), null);
  assert.equal(unseal(key, "hello"), null);
  assert.equal(unseal(key, ""), null);
});

test("worst case device (31 busy days, every hour of the week busy) fits one message", () => {
  const { key } = derive(acct);
  const days = {}, hours = {};
  for (let i = 0; i < 31; i++) days[`2026-08-${String(i + 1).padStart(2, "0")}`] = { w: 123.456, f: 12.345, o: 98.765, s: 11.111, h: 1.235 };
  const t0 = Date.parse("2026-09-19T00:00:00Z");
  for (let i = 0; i < 168; i++) hours[new Date(t0 + i * 3600e3).toISOString().slice(0, 13)] = 1.234 + i / 1000;
  const dev = { name: "x".repeat(40), nameSetAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z", days, hours };
  const body = sealDevice(key, "0123456789abcdef", dev);
  assert.ok(body.length <= MAX_BODY, `body ${body.length}`);
  const back = unseal(key, body);
  assert.equal(back.id, "0123456789abcdef");
  assert.equal(Object.keys(back.dev.days).length, 31);
});
