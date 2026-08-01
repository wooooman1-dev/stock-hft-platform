import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  KIS_MODE_PROD_READ_ONLY,
  loadKisConfiguration,
} from "../integrations/kis/kisConfig.js";
import { KisProdReadOnlyClient } from "../integrations/kis/kisProdReadOnlyClient.js";
import { KisTokenStore } from "../integrations/kis/kisTokenStore.js";

test("KIS external error text redacts app key and app secret", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pulsehft-kis-security-"));
  try {
    const credentialPath = join(directory, "kis-prod-read-only.json");
    writeFileSync(credentialPath, JSON.stringify({
      appKey: "sensitive-app-key",
      appSecret: "sensitive-app-secret",
    }), "utf8");
    const config = loadKisConfiguration(credentialPath, {
      env: { PULSEHFT_KIS_MODE: KIS_MODE_PROD_READ_ONLY },
    });
    const client = new KisProdReadOnlyClient({
      config,
      tokenStore: new KisTokenStore(join(directory, "kis-prod-token.json")),
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        async json() {
          return {
            error_description: "sensitive-app-key / sensitive-app-secret 접근 거부",
          };
        },
      }),
    });

    await assert.rejects(
      () => client.getAccessToken(),
      (error) => {
        assert.equal(error.message.includes("sensitive-app-key"), false);
        assert.equal(error.message.includes("sensitive-app-secret"), false);
        assert.match(error.message, /\[REDACTED\]/);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
