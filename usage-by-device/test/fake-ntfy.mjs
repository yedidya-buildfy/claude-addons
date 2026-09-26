// A stand-in for the ntfy mailbox: publish, and poll since an id or a duration.
import http from "node:http";

export async function fakeNtfy() {
  const msgs = [];
  let n = 0, requests = 0;
  const srv = http.createServer((req, res) => {
    requests++;
    const u = new URL(req.url, "http://x");
    const [, topic, kind] = u.pathname.split("/");
    if (req.method === "POST") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        if (Buffer.byteLength(b) > 4096) { res.writeHead(413); return res.end("{}"); }
        const m = { id: `m${++n}`, time: Math.floor(Date.now() / 1000), event: "message", topic, message: b };
        msgs.push(m);
        res.end(JSON.stringify(m));
      });
      return;
    }
    if (kind === "json" && u.searchParams.get("poll") === "1") {
      const i = msgs.findIndex((m) => m.id === u.searchParams.get("since"));
      res.end(msgs.slice(i + 1).filter((m) => m.topic === topic).map((m) => JSON.stringify(m) + "\n").join(""));
      return;
    }
    res.writeHead(404); res.end("{}");
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  srv.unref(); // a failed test must not keep the run alive
  return { url: `http://127.0.0.1:${srv.address().port}`, msgs, requests: () => requests, close: () => { srv.close(); srv.closeAllConnections(); } };
}
