// How machines on the same plan find each other and talk: a channel and a key
// derived from the Claude subscription, encrypted messages in an ntfy mailbox.
import crypto from "node:crypto";
import zlib from "node:zlib";

export const DEFAULT_SERVER = "https://usage.zencocovillas.com";
export const MAX_BODY = 4000; // ntfy turns bodies over 4096 bytes into attachments

export function derive(oauth) {
  if (!oauth?.accountUuid || !oauth?.organizationUuid) return null;
  const secret = `${oauth.accountUuid}:${oauth.organizationUuid}`;
  const h = (label) => crypto.createHmac("sha256", secret).update(label).digest();
  return { topic: "ubd_" + h("usage-by-device/topic/v1").toString("hex").slice(0, 40), key: h("usage-by-device/key/v1") };
}

export function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(zlib.gzipSync(JSON.stringify(obj))), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function unseal(key, text) {
  try {
    const b = Buffer.from(text, "base64");
    if (b.length < 29) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(b.subarray(28)), d.final()])).toString("utf8"));
  } catch {
    return null;
  }
}

// One device per message. If it ever outgrows a message the hours go first;
// the 5-hour / week columns then fall back to what the receiver already had.
export function sealDevice(key, id, dev) {
  const body = seal(key, { kind: "device", id, dev });
  return body.length <= MAX_BODY ? body : seal(key, { kind: "device", id, dev: { ...dev, hours: {} } });
}

export async function publish(server, topic, body, f = fetch) {
  const r = await f(`${server}/${topic}`, { method: "POST", body, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`publish ${r.status}`);
  return (await r.json()).id;
}

export async function poll(server, topic, since, f = fetch) {
  const r = await f(`${server}/${topic}/json?poll=1&since=${encodeURIComponent(since)}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`poll ${r.status}`);
  const out = [];
  for (const l of (await r.text()).split("\n")) {
    if (!l) continue;
    try { const e = JSON.parse(l); if (e.event === "message" && typeof e.message === "string") out.push(e); } catch {}
  }
  return out;
}
