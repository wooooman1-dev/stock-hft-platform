import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  extractFirstZipEntry,
  InstrumentCatalog,
  InstrumentCatalogError,
  parseKisMasterText,
  rankInstruments,
} from "../domain/instrumentCatalog.js";

function buildMasterLine({ symbol, standardCode = `KR7${symbol}000`, name, group = "ST", tailLength }) {
  const head = `${symbol.padEnd(9)}${standardCode.padEnd(12)}${name}`;
  return `${head}${group.padEnd(tailLength - 1)}\n`;
}

function buildZip(content, { fileName = "master.mst", compression = 8 } = {}) {
  const raw = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const compressed = compression === 8 ? deflateRawSync(raw) : raw;
  const name = Buffer.from(fileName);

  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(compression, 8);
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(compression, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + compressed.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([local, compressed, central, eocd]);
}

function responseFor(buffer) {
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

test("ZIP parser extracts stored and deflated KIS master entries", () => {
  const content = Buffer.from("005930 TEST\n");
  assert.deepEqual(extractFirstZipEntry(buildZip(content, { compression: 0 })), content);
  assert.deepEqual(extractFirstZipEntry(buildZip(content, { compression: 8 })), content);
});

test("KIS master parser extracts symbol, name, market and security type", () => {
  const text = [
    buildMasterLine({ symbol: "005930", name: "삼성전자", group: "ST", tailLength: 228 }),
    buildMasterLine({ symbol: "069500", name: "KODEX 200", group: "EF", tailLength: 228 }),
  ].join("");
  assert.deepEqual(parseKisMasterText(text, { market: "KOSPI", tailLength: 228 }), [
    {
      symbol: "005930",
      standardCode: "KR7005930000",
      name: "삼성전자",
      market: "KOSPI",
      securityTypeCode: "ST",
      securityType: "주식",
    },
    {
      symbol: "069500",
      standardCode: "KR7069500000",
      name: "KODEX 200",
      market: "KOSPI",
      securityTypeCode: "EF",
      securityType: "ETF",
    },
  ]);
});

test("ranking prioritizes exact code, exact name, prefix and contains matches", () => {
  const instruments = [
    { symbol: "005930", standardCode: null, name: "삼성전자", market: "KOSPI" },
    { symbol: "005935", standardCode: null, name: "삼성전자우", market: "KOSPI" },
    { symbol: "000660", standardCode: null, name: "SK하이닉스", market: "KOSPI" },
  ];
  assert.deepEqual(rankInstruments(instruments, "005930").map((item) => item.symbol), ["005930"]);
  assert.deepEqual(rankInstruments(instruments, "삼성전자").map((item) => item.symbol), ["005930", "005935"]);
  assert.deepEqual(rankInstruments(instruments, "하이닉스").map((item) => item.symbol), ["000660"]);
});

test("catalog downloads KOSPI and KOSDAQ masters, caches them, and searches by name or code", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pulsehft-instruments-"));
  const cachePath = join(directory, "instrument-catalog.json");
  let fetchCount = 0;
  try {
    const kospiLines = Array.from({ length: 60 }, (_, index) => buildMasterLine({
      symbol: String(100000 + index).slice(-6),
      name: index === 0 ? "ALPHA HOLDINGS" : `KOSPI TEST ${index}`,
      tailLength: 228,
    })).join("");
    const kosdaqLines = Array.from({ length: 60 }, (_, index) => buildMasterLine({
      symbol: String(200000 + index).slice(-6),
      name: index === 0 ? "BETA LAB" : `KOSDAQ TEST ${index}`,
      tailLength: 222,
    })).join("");
    const archives = {
      "https://example.test/kospi.zip": buildZip(Buffer.from(kospiLines)),
      "https://example.test/kosdaq.zip": buildZip(Buffer.from(kosdaqLines)),
    };
    const sources = [
      { market: "KOSPI", url: "https://example.test/kospi.zip", tailLength: 228 },
      { market: "KOSDAQ", url: "https://example.test/kosdaq.zip", tailLength: 222 },
    ];
    const catalog = new InstrumentCatalog(cachePath, {
      sources,
      now: () => 1_780_000_000_000,
      fetchImpl: async (url) => {
        fetchCount += 1;
        return responseFor(archives[String(url)]);
      },
    });

    const alpha = await catalog.search("alpha");
    assert.equal(alpha.results[0].symbol, "100000");
    assert.equal(alpha.results[0].market, "KOSPI");
    assert.equal(alpha.catalog.instrumentCount, 120);
    assert.equal(fetchCount, 2);

    const byCode = await catalog.search("200000");
    assert.equal(byCode.results[0].name, "BETA LAB");
    assert.equal(fetchCount, 2);

    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(cached.instruments.length, 120);

    const restarted = new InstrumentCatalog(cachePath, {
      sources,
      now: () => 1_780_000_000_001,
      fetchImpl: async () => { throw new Error("network must not be called"); },
    });
    const replayed = await restarted.search("beta");
    assert.equal(replayed.results[0].symbol, "200000");
    assert.equal(replayed.catalog.state, "READY");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stale catalog is used when refresh fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pulsehft-instruments-stale-"));
  const cachePath = join(directory, "instrument-catalog.json");
  try {
    const instruments = Array.from({ length: 120 }, (_, index) => ({
      symbol: String(300000 + index).slice(-6),
      standardCode: null,
      name: `STALE ${index}`,
      market: index < 60 ? "KOSPI" : "KOSDAQ",
      securityTypeCode: "ST",
      securityType: "주식",
    }));
    const cached = { schemaVersion: 1, updatedAt: 1000, instruments };
    await import("node:fs").then(({ writeFileSync }) => writeFileSync(cachePath, JSON.stringify(cached)));
    const catalog = new InstrumentCatalog(cachePath, {
      now: () => 1_780_000_000_000,
      maxAgeMs: 1,
      fetchImpl: async () => { throw new Error("offline"); },
    });
    const result = await catalog.search("STALE 1");
    assert.equal(result.catalog.state, "STALE");
    assert.equal(result.catalog.stale, true);
    assert.ok(result.results.length > 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("catalog rejects empty queries and unsafe limits before loading", async () => {
  const catalog = new InstrumentCatalog("unused.json", {
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  await assert.rejects(() => catalog.search(""), (error) => (
    error instanceof InstrumentCatalogError
    && error.code === "INSTRUMENT_SEARCH_QUERY_REQUIRED"
    && error.statusCode === 400
  ));
  await assert.rejects(() => catalog.search("삼성", { limit: 51 }), (error) => (
    error instanceof InstrumentCatalogError
    && error.code === "INSTRUMENT_SEARCH_LIMIT_INVALID"
  ));
});


const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

function readProjectFile(path) {
  return readFileSync(join(projectRoot, path), "utf8");
}

test("dashboard loads the isolated instrument search UI", () => {
  const html = readProjectFile("public/index.html");
  assert.match(html, /instrumentSearch\.js/);

  const source = readProjectFile("public/instrumentSearch.js");
  assert.match(source, /\/api\/instruments\/search/);
  assert.match(source, /\/api\/instruments\/select/);
  assert.match(source, /메인 SIMULATION 차트·호가·체결·분석을 새로 시작합니다/);
  assert.match(source, /pulsehft:instrument-selected/);
  assert.match(source, /pulsehftInstrumentSearch/);
});

test("server exposes loopback-only instrument search and catalog health", () => {
  const source = readProjectFile("server/app.js");
  assert.match(source, /new InstrumentCatalog\(join\(dataDir, "instrument-catalog\.json"\)\)/);
  assert.match(source, /url\.pathname === "\/api\/instruments\/search"/);
  assert.match(source, /url\.pathname === "\/api\/instruments\/select"/);
  assert.match(source, /selectedInstrumentStore\.save/);
  assert.match(source, /runtime\.switchInstrument/);
  assert.match(source, /rejectNonLoopbackKisRequest\(request, response\)/);
  assert.match(source, /instruments: instrumentCatalog\.status\(\)/);
});
