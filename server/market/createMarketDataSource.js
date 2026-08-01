import { LsAuthClient } from "../brokers/ls/lsAuthClient.js";
import { LsMarketDataSource } from "../brokers/ls/lsMarketDataSource.js";
import { LsRealtimeClient } from "../brokers/ls/lsRealtimeClient.js";
import { LsRestClient } from "../brokers/ls/lsRestClient.js";
import { SimulationMarketDataSource } from "./simulationMarketDataSource.js";

export function createMarketDataSource({ env = process.env, symbol, initialPrice }) {
  const mode = String(env.MARKET_MODE ?? "simulation").trim().toLowerCase();
  if (mode === "simulation") return new SimulationMarketDataSource(initialPrice);
  if (mode !== "ls") throw new Error(`지원하지 않는 MARKET_MODE: ${mode}`);

  const environment = String(env.LS_ENVIRONMENT ?? "paper").trim().toLowerCase();
  if (!["paper", "live"].includes(environment)) {
    throw new Error("LS_ENVIRONMENT는 paper 또는 live여야 합니다.");
  }
  const authClient = new LsAuthClient({
    appKey: env.LS_APP_KEY,
    appSecret: env.LS_APP_SECRET,
  });
  const restClient = new LsRestClient({ authClient });
  const realtimeClient = new LsRealtimeClient({ authClient, environment });
  return new LsMarketDataSource({
    symbol,
    market: env.LS_MARKET ?? "KOSPI",
    environment,
    restClient,
    realtimeClient,
  });
}
