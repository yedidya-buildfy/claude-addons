# usage-by-device mailbox

Stock `binwiederhier/ntfy` on the Akamai box, straight on the server's IP — no
domain, no DNS, no Coolify resource. Payloads are AES-GCM encrypted by the
add-on, so plain HTTP only exposes the (unguessable) topic name, never usage.

Address: http://172.233.209.162:8095 (the add-on's default; override per machine
in ~/.claude/usage-by-device/server).

Recreate:

    docker run -d --name ubd-mailbox --restart unless-stopped -m 64m --memory-swap 64m --cpus 0.5 \
      -p 8095:80 -v ubd-mailbox:/var/cache/ntfy \
      -e NTFY_BASE_URL=http://172.233.209.162:8095 -e NTFY_CACHE_FILE=/var/cache/ntfy/cache.db -e NTFY_CACHE_DURATION=168h \
      -e NTFY_ATTACHMENT_CACHE_DIR= -e NTFY_MESSAGE_SIZE_LIMIT=4096 -e NTFY_WEB_ROOT=disable \
      -e NTFY_ENABLE_SIGNUP=false -e NTFY_ENABLE_LOGIN=false \
      -e NTFY_VISITOR_REQUEST_LIMIT_BURST=60 -e NTFY_VISITOR_REQUEST_LIMIT_REPLENISH=5s -e NTFY_VISITOR_MESSAGE_DAILY_LIMIT=5000 \
      binwiederhier/ntfy serve

Check: publish, `docker restart ubd-mailbox`, poll with since=72h — the message is still there.
Oversized bodies (>4096 bytes) are refused with 400.
