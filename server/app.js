import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutionJournal } from "./domain/executionJournal.js";
import { MarketRuntime } from "./domain/runtime.js";
import { StrategySettingsStore } from "./domain/strategySettingsStore.js";
import {
  applyVerificationMarketTick,
  isLoopbackAddress,
  isVerificationApiEnabled,
} from "./domain/verificationMarket.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const publicDir = join(root, "public");
const dataDir = process.env.PULSEHFT_DATA_DIR
  ? resolve(process.env.PULSEHFT_DATA_DIR)
  : join(root, ".pulsehft");
const symbol = process.env.DEFAULT_SYMBOL ?? "005930";
const symbolName = process.env.DEFAULT_SYMBOL_NAME ?? "삼성전자";
const initialPrice = Number(process.env.DEFAULT_PRICE ?? 70_000);
const strategySettingsStore = new StrategySettingsStore(join(dataDir, "strategy-settings.json"));
const executionJournal = new ExecutionJournal(join(dataDir, "execution-journal.jsonl"));
executionJournal.append("SESSION_STARTED", {
  mode: "SIMULATION",
  symbol,
  symbolName,
  processId: process.pid,
});
const verificationApiEnabled = isVerificationApiEnabled(process.env);
const port = Number(process.env.PORT ?? 8787);
const runtime = new MarketRuntime(
  symbol,
  symbolName,
  initialPrice,
  {
    strategySettings: strategySettingsStore.load(),
    strategySettingsStore,
    executionJournal,
  },
);
const eventClients = new Set();
runtime.start();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("올바른 JSON 요청이 아닙니다."); }
}

function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(publicDir, "index.html");
  }
  response.writeHead(200, {
    "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=300",
  });
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { status: "ok", mode: "SIMULATION", clients: eventClients.size });
    }
    if (request.method === "GET" && url.pathname === "/api/snapshot") {
      return json(response, 200, runtime.snapshot());
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write(`event: snapshot\ndata: ${JSON.stringify(runtime.snapshot())}\n\n`);
      eventClients.add(response);
      request.on("close", () => eventClients.delete(response));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/strategy/settings") {
      return json(response, 200, runtime.getStrategySettings());
    }
    if (request.method === "PUT" && url.pathname === "/api/strategy/settings") {
      return json(response, 200, runtime.setStrategySettings(await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/strategy/settings/reset") {
      return json(response, 200, runtime.resetStrategySettings());
    }
    if (request.method === "POST" && url.pathname === "/api/verification/market-tick") {
      if (!verificationApiEnabled || !isLoopbackAddress(request.socket.remoteAddress)) {
        return json(response, 404, { error: "요청한 경로를 찾을 수 없습니다." });
      }
      return json(response, 200, applyVerificationMarketTick(runtime, await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/paper/orders") {
      const body = await readJson(request);
      return json(response, 200, runtime.submitOrder({
        side: body.side,
        type: body.type ?? "MARKET",
        quantity: body.quantity,
        limitPrice: body.limitPrice,
        clientOrderId: body.clientOrderId,
        source: "MANUAL",
      }));
    }
    const cancelMatch = request.method === "POST"
      ? url.pathname.match(/^\/api\/paper\/orders\/([^/]+)\/cancel$/)
      : null;
    if (cancelMatch) {
      return json(response, 200, runtime.cancelOrder(decodeURIComponent(cancelMatch[1])));
    }
    if (request.method === "POST" && url.pathname === "/api/system/kill-switch") {
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean") return json(response, 400, { error: "enabled(boolean)가 필요합니다." });
      runtime.setKillSwitch(body.enabled);
      return json(response, 200, runtime.snapshot());
    }
    if (request.method === "POST" && url.pathname === "/api/strategy/auto") {
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean") return json(response, 400, { error: "enabled(boolean)가 필요합니다." });
      runtime.setAutoPaperTrading(body.enabled);
      return json(response, 200, runtime.snapshot());
    }
    if (request.method === "POST" && url.pathname === "/api/paper/reset") {
      runtime.resetPaperAccount();
      return json(response, 200, runtime.snapshot());
    }
    if (request.method === "GET") return serveStatic(url.pathname, response);
    return json(response, 404, { error: "요청한 경로를 찾을 수 없습니다." });
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    return json(response, status, {
      error: error instanceof Error ? error.message : "서버 오류",
      code: error?.code ?? "SERVER_ERROR",
    });
  }
});

runtime.on("snapshot", (snapshot) => {
  const payload = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
  for (const client of eventClients) client.write(payload);
});

const heartbeat = setInterval(() => {
  for (const client of eventClients) client.write(": heartbeat\n\n");
}, 15_000);

server.listen(port, "0.0.0.0", () => {
  console.log(`PulseHFT running at http://localhost:${port}`);
});

function shutdown() {
  clearInterval(heartbeat);
  runtime.stop();
  for (const client of eventClients) client.end();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
