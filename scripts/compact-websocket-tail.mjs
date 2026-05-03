/**
 * Pipes `wrangler tail --format json` and turns Cloudflare "websocket:message"
 * cf-worker-event lines (the ones Wrangler's "pretty" mode shows as
 * "Unknown Event") into a single human-readable line each.
 *
 * Input: one JSON object per line (NDJSON). If Wrangler ever prints
 * pretty-printed multi-line JSON, this script will not join those lines; use
 * the raw one-line form from the tail stream or capture logs elsewhere.
 *
 * Usage (PowerShell / bash):
 *   npx wrangler tail --format json 2>&1 | node scripts/compact-websocket-tail.mjs
 *   npm run tail:compact
 */

import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of rl) {
  const t = line.trim();
  if (!t) {
    process.stdout.write("\n");
    continue;
  }
  let o;
  try {
    o = JSON.parse(t);
  } catch {
    process.stdout.write(line + "\n");
    continue;
  }

  // Cloudflare cf-worker-event envelope (live tail / dashboard-style)
  if (o?.$workers?.eventType === "websocket" && o?.$workers?.event?.getWebSocketEvent) {
    const w = o.$workers;
    const wsType = w.event.getWebSocketEvent?.webSocketEventType ?? "event";
    const ep = w.entrypoint ?? "?";
    const outcome = w.outcome ?? "ok";
    const doId = w.durableObjectId ? ` DO=${String(w.durableObjectId).slice(0, 8)}…` : "";
    const wall = typeof w.wallTimeMs === "number" ? ` wall=${w.wallTimeMs}ms` : "";
    process.stdout.write(
      `WebSocket:${wsType} [${w.scriptName ?? "?"}] ${ep} — ${outcome}${doId}${wall}\n`
    );
    continue;
  }

  // Legacy tail envelope: { event: { getWebSocketEvent: ... }, outcome, ... }
  if (o?.event && typeof o.event === "object" && "getWebSocketEvent" in o.event) {
    const wsType = o.event.getWebSocketEvent?.webSocketEventType ?? "event";
    const entry = o.entrypoint ?? o.scriptName ?? "?";
    const outcome = o.outcome ?? "ok";
    const when = o.eventTimestamp
      ? new Date(o.eventTimestamp).toLocaleString()
      : "";
    process.stdout.write(
      `WebSocket:${wsType} [${entry}] — ${outcome} @ ${when}\n`
    );
    continue;
  }

  process.stdout.write(line + "\n");
}
