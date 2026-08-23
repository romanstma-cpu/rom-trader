/**
 * Playtest: exercises the store, strategy presets and engine rules without a
 * window. Everything that does not need live market data is asserted here so a
 * UI pass only has to cover what the UI actually owns.
 *
 * Build + run:
 *   npm run build
 *   npx esbuild test/playtest.ts --bundle --platform=node \
 *     --alias:electron=./test/electron-stub.js --outfile=test/playtest.js
 *   node test/playtest.js
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { TradingEngine } from "../electron/engine/engine";
import { STRATEGIES, findStrategy } from "../electron/engine/strategies";
import {
  DEFAULT_SETTINGS,
  clearHistory,
  dataDir,
  deleteProfile,
  factoryReset,
  historyToCsv,
  loadAppState,
  loadHistory,
  loadProfiles,
  loadSettings,
  saveAppState,
  saveProfile,
  saveSettings,
  type TradeRecord,
} from "../electron/engine/store";
import {
  clearCredentials,
  credentialStatus,
  loadCredentials,
  migrateLegacyCredentials,
  saveCredentials,
} from "../electron/engine/credentials";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

function reset(): void {
  factoryReset();
  clearCredentials(); // also drops the vault's in-memory cache
}

// ---------------------------------------------------------------- store

section("settings persistence");
reset();
check("fresh install returns defaults", loadSettings().tradeSizeUsd === DEFAULT_SETTINGS.tradeSizeUsd);

saveSettings({ ...DEFAULT_SETTINGS, tradeSizeUsd: 25, maxPositions: 7 });
check("saved values round-trip", loadSettings().tradeSizeUsd === 25 && loadSettings().maxPositions === 7);

section("settings sanitising");
saveSettings({ ...DEFAULT_SETTINGS, maxPositions: 9999, tickSeconds: 1, stopLossCents: -4 });
const clamped = loadSettings();
check("maxPositions clamped to 50", clamped.maxPositions === 50, `got ${clamped.maxPositions}`);
check("tickSeconds floored at 5", clamped.tickSeconds === 5, `got ${clamped.tickSeconds}`);
check("negative stop loss clamped to >= 1", clamped.stopLossCents >= 1, `got ${clamped.stopLossCents}`);

saveSettings({ ...DEFAULT_SETTINGS, tradeSizeUsd: NaN });
check("NaN falls back to default", loadSettings().tradeSizeUsd === DEFAULT_SETTINGS.tradeSizeUsd);

section("hand-edited files");
reset();
const settingsPath = path.join(dataDir(), "settings.json");
fs.writeFileSync(settingsPath, "﻿" + JSON.stringify({ tradeSizeUsd: 42 }), "utf-8");
check("UTF-8 BOM does not wipe settings", loadSettings().tradeSizeUsd === 42, `got ${loadSettings().tradeSizeUsd}`);

fs.writeFileSync(settingsPath, "{ this is not json", "utf-8");
check("corrupt settings fall back to defaults", loadSettings().tradeSizeUsd === DEFAULT_SETTINGS.tradeSizeUsd);

fs.writeFileSync(path.join(dataDir(), "history.json"), '{"not":"an array"}', "utf-8");
check("non-array history returns []", loadHistory().length === 0);

section("app state");
reset();
check("disclaimer starts unaccepted", loadAppState().disclaimerAccepted === false);
saveAppState({ ...loadAppState(), disclaimerAccepted: true });
check("disclaimer persists once accepted", loadAppState().disclaimerAccepted === true);

// ---------------------------------------------------------------- strategies

section("strategy presets");
reset();
check("three presets ship", STRATEGIES.length === 3, `got ${STRATEGIES.length}`);
check("ids are unique", new Set(STRATEGIES.map((s) => s.id)).size === STRATEGIES.length);
check("unknown id is not found", findStrategy("nope") === undefined);

for (const s of STRATEGIES) {
  check(
    `${s.name}: take-profit exceeds stop`,
    s.params.takeProfitCents > s.params.stopLossCents,
    `${s.params.takeProfitCents}c vs ${s.params.stopLossCents}c`,
  );
  check(
    `${s.name}: price band is sane`,
    s.params.minPriceCents < s.params.maxPriceCents && s.params.maxPriceCents <= 99,
  );
  check(`${s.name}: survives sanitising unchanged`, (() => {
    saveSettings({ ...DEFAULT_SETTINGS, ...s.params });
    const after = loadSettings();
    return (Object.keys(s.params) as (keyof typeof s.params)[]).every((k) => after[k] === s.params[k]);
  })());
}

// ---------------------------------------------------------------- credentials

section("credential vault");
reset();

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc123\n-----END RSA PRIVATE KEY-----";

check("no key on a fresh install", credentialStatus().configured === false);
check("missing vault reads as blank, not a crash", loadCredentials().apiKeyId === "");

saveCredentials({ apiKeyId: "abcdef01-2345-6789-abcd-ef0123456789", apiPrivateKeyPem: PEM });
check("saved key round-trips", loadCredentials().apiPrivateKeyPem === PEM);
check("status reports configured", credentialStatus().configured === true);
check(
  "status hints at the id without printing it",
  credentialStatus().keyIdHint === "abcdef01…6789",
  credentialStatus().keyIdHint,
);

const vaultRaw = fs.readFileSync(path.join(dataDir(), "credentials.dat"), "utf-8");
check("vault does not contain the PEM in the clear", !vaultRaw.includes("BEGIN RSA"));
check("vault does not contain the key id in the clear", !vaultRaw.includes("abcdef01-2345"));

// A renderer on an old build could still post credential fields; they must not
// land in settings.json even so.
saveSettings({
  ...DEFAULT_SETTINGS,
  tradeSizeUsd: 12,
  apiKeyId: "abcdef01-2345-6789-abcd-ef0123456789",
  apiPrivateKeyPem: PEM,
} as never);
const settingsRaw = fs.readFileSync(path.join(dataDir(), "settings.json"), "utf-8");
check("settings.json holds no key material", !settingsRaw.includes("BEGIN RSA"));
check("settings.json holds no key id", !settingsRaw.includes("abcdef01-2345"));
check("credential fields are dropped, not just blanked", !settingsRaw.includes("apiPrivateKeyPem"));
check("unrelated settings still save", loadSettings().tradeSizeUsd === 12);

clearCredentials();
check("clearing removes the key", credentialStatus().configured === false);
check("clearing deletes the file", !fs.existsSync(path.join(dataDir(), "credentials.dat")));

saveCredentials({ apiKeyId: "  ", apiPrivateKeyPem: "  " });
check("a blank pair is treated as no key", credentialStatus().configured === false);

// -- migration from 1.1.1, where the key sat in settings.json as plain text
reset();
fs.writeFileSync(
  path.join(dataDir(), "settings.json"),
  JSON.stringify(
    { ...DEFAULT_SETTINGS, apiKeyId: "LEGACY-ID", apiPrivateKeyPem: PEM, tradeSizeUsd: 17 },
    null,
    2,
  ),
  "utf-8",
);
check("migration reports that it ran", migrateLegacyCredentials() === true);
check("migrated key is readable from the vault", loadCredentials().apiKeyId === "LEGACY-ID");
check("migrated PEM survived intact", loadCredentials().apiPrivateKeyPem === PEM);

const afterMigration = fs.readFileSync(path.join(dataDir(), "settings.json"), "utf-8");
check("migration strips the key from settings.json", !afterMigration.includes("LEGACY-ID"));
check("migration strips the PEM from settings.json", !afterMigration.includes("BEGIN RSA"));
check("migration keeps unrelated settings", loadSettings().tradeSizeUsd === 17);
check("migration is not repeated once done", migrateLegacyCredentials() === false);

reset();
check("nothing to migrate on a clean install", migrateLegacyCredentials() === false);

// A half-filled legacy pair is junk, but must still be scrubbed from the file.
reset();
fs.writeFileSync(
  path.join(dataDir(), "settings.json"),
  JSON.stringify({ ...DEFAULT_SETTINGS, apiKeyId: "ORPHAN-ID", apiPrivateKeyPem: "" }, null, 2),
  "utf-8",
);
migrateLegacyCredentials();
check("an incomplete legacy pair is not stored", credentialStatus().configured === false);
check(
  "an incomplete legacy pair is still scrubbed",
  !fs.readFileSync(path.join(dataDir(), "settings.json"), "utf-8").includes("ORPHAN-ID"),
);

// ---------------------------------------------------------------- profiles

section("saved setups");
reset();
saveSettings({ ...DEFAULT_SETTINGS, liveMode: true, tradeSizeUsd: 33 });
saveCredentials({ apiKeyId: "SECRET-ID", apiPrivateKeyPem: "SECRET-PEM" });
saveProfile("evening", loadSettings());
const prof = loadProfiles()[0];
check("profile is saved", prof !== undefined && prof.name === "evening");
check("profile keeps engine params", prof.params.tradeSizeUsd === 33);
const profJson = JSON.stringify(prof);
check("profile excludes API key id", !profJson.includes("SECRET-ID"));
check("profile excludes private key", !profJson.includes("SECRET-PEM"));
check("profile excludes live mode", !("liveMode" in prof.params));

saveProfile("evening", { ...loadSettings(), tradeSizeUsd: 44 });
check("same name overwrites rather than duplicates", loadProfiles().length === 1, `got ${loadProfiles().length}`);
check("overwrite kept the new value", loadProfiles()[0].params.tradeSizeUsd === 44);

let blankRejected = false;
try {
  saveProfile("   ", loadSettings());
} catch {
  blankRejected = true;
}
check("blank profile name is rejected", blankRejected);

saveProfile("second", loadSettings());
check("profiles sort by name", loadProfiles().map((p) => p.name).join(",") === "evening,second");
deleteProfile("evening");
check("delete removes only the target", loadProfiles().length === 1 && loadProfiles()[0].name === "second");

// ---------------------------------------------------------------- csv

section("history export");
reset();
const rows: TradeRecord[] = [
  {
    ticker: "KXTEST-1", title: 'Comma, and "quote" test', side: "yes",
    entryCents: 40, exitCents: 46, contracts: 25, pnlUsd: 1.5,
    openedAt: 1_700_000_000_000, closedAt: 1_700_000_060_000, reason: "take-profit", dryRun: true,
  },
  {
    ticker: "KXTEST-2", title: "Plain", side: "yes",
    entryCents: 60, exitCents: 56, contracts: 16, pnlUsd: -0.64,
    openedAt: 1_700_000_000_000, closedAt: 1_700_000_120_000, reason: "stop-loss", dryRun: false,
  },
];
const csv = historyToCsv(rows);
const lines = csv.split("\r\n");
check("csv has header plus a row per trade", lines.length === 3, `got ${lines.length}`);
check("csv escapes commas and quotes", lines[1].includes('"Comma, and ""quote"" test"'));
check("csv marks paper vs live", lines[1].endsWith("paper") && lines[2].endsWith("live"));
check("csv keeps the loss sign", lines[2].includes("-0.64"));
check("empty history still yields a header", historyToCsv([]).split("\r\n").length === 1);

// ---------------------------------------------------------------- engine

section("engine rules");
reset();

type Mkt = {
  ticker: string; title: string; yes_bid: number; yes_ask: number;
  last_price: number; volume: number; volume_24h: number; status: string;
};
const mkt = (ticker: string, bid: number, ask: number): Mkt => ({
  ticker, title: `${ticker} title`, yes_bid: bid, yes_ask: ask,
  last_price: bid, volume: 100, volume_24h: 100, status: "active",
});

/** Drive private tick internals with a scripted market book. */
function runEngine(settings: Partial<typeof DEFAULT_SETTINGS>, books: Mkt[][]) {
  const e = new TradingEngine({ ...DEFAULT_SETTINGS, ...settings });
  const anyE = e as unknown as {
    status: string;
    updatePositions: (m: Mkt[]) => void;
    scanForEntries: (m: Mkt[], t: number) => void;
    enforceDailyLossLimit: () => void;
  };
  anyE.status = "running";
  for (const book of books) {
    anyE.updatePositions(book);
    anyE.scanForEntries(book, Date.now());
    anyE.enforceDailyLossLimit();
  }
  return e;
}

// four flat books warm up history, then a jump past the 3c trigger
const flat = [mkt("KXA", 40, 41)];
const jump = [mkt("KXA", 45, 46)];
let e = runEngine({ momentumThresholdCents: 3 }, [flat, flat, flat, flat, jump]);
check("momentum past the trigger opens a position", e.getState().positions.length === 1);

// same rise, but the spread is wider than allowed
const wideFlat = [mkt("KXB", 40, 45)];
const wideJump = [mkt("KXB", 45, 50)];
e = runEngine({ maxSpreadCents: 2 }, [wideFlat, wideFlat, wideFlat, wideFlat, wideJump]);
check("wide spread blocks entry", e.getState().positions.length === 0);

// price outside the configured band
const cheapFlat = [mkt("KXC", 2, 3)];
const cheapJump = [mkt("KXC", 7, 8)];
e = runEngine({ minPriceCents: 10 }, [cheapFlat, cheapFlat, cheapFlat, cheapFlat, cheapJump]);
check("price below the floor blocks entry", e.getState().positions.length === 0);

// respects the position cap
const many = ["KXD", "KXE", "KXF"].map((t) => mkt(t, 40, 41));
const manyUp = ["KXD", "KXE", "KXF"].map((t) => mkt(t, 45, 46));
e = runEngine({ maxPositions: 2 }, [many, many, many, many, manyUp]);
check("position cap is respected", e.getState().positions.length === 2, `got ${e.getState().positions.length}`);

// take-profit closes the trade and the cooldown stops it re-buying at the ask
e = runEngine({ takeProfitCents: 4, reentryCooldownSeconds: 90 }, [flat, flat, flat, flat, jump, [mkt("KXA", 52, 53)]]);
check("take-profit closes the position", e.getState().positions.length === 0);
check("take-profit is recorded to history", loadHistory().some((t) => t.reason === "take-profit"));
check("cooldown prevents same-tick re-entry", loadHistory().length === 1, `${loadHistory().length} trades`);
check(
  "signals explain the cooldown",
  e.getSignals().some((s) => s.reason.includes("cooling down")),
);
check("scanner counts the cooldown skip", (e.getState().scanner?.skippedCooldown ?? 0) === 1);

// with the cooldown off, the old churn behaviour is still available
clearHistory();
e = runEngine({ takeProfitCents: 4, reentryCooldownSeconds: 0 }, [flat, flat, flat, flat, jump, [mkt("KXA", 52, 53)]]);
check("cooldown 0 allows immediate re-entry", e.getState().positions.length === 1);

// stop-loss closes the trade
clearHistory();
e = runEngine({ stopLossCents: 3 }, [flat, flat, flat, flat, jump, [mkt("KXA", 40, 41)]]);
check("stop-loss closes the position", e.getState().positions.length === 0);
check("stop-loss is recorded to history", loadHistory().some((t) => t.reason === "stop-loss"));

// flatten
clearHistory();
e = runEngine({}, [flat, flat, flat, flat, jump]);
const flattened = e.flatten();
check("flatten reports how many it closed", flattened === 1, `got ${flattened}`);
check("flatten leaves nothing open", e.getState().positions.length === 0);
check("flatten on an empty book is a no-op", e.flatten() === 0);

// signals surface a reason for every market seen
clearHistory();
e = runEngine({ maxSpreadCents: 2 }, [wideFlat, wideFlat]);
const sigs = e.getSignals();
check("signals are produced", sigs.length > 0);
check("every signal carries a reason", sigs.every((s) => s.reason.trim().length > 0));
check("wide-spread signal names the spread", sigs.some((s) => s.reason.includes("spread")));
const stats = e.getState().scanner;
check("scanner stats are populated", stats !== null && stats.marketsScanned === 1);
check("scanner counts the spread skip", stats !== null && stats.skippedSpread === 1);

// idle hint explains why nothing is trading
clearHistory();
e = runEngine({ maxSpreadCents: 2 }, [wideFlat, wideFlat]);
check("no hint before three barren scans", e.getState().idleHint === null);
e = runEngine({ maxSpreadCents: 2 }, [wideFlat, wideFlat, wideFlat, wideFlat]);
const hint = e.getState().idleHint ?? "";
check("barren scans produce a hint", hint.length > 0);
check("hint blames the spread limit", hint.includes("spread"), hint);
check("hint names the setting to change", hint.includes("Max spread"), hint);

e = runEngine({ minPriceCents: 10 }, [cheapFlat, cheapFlat, cheapFlat, cheapFlat]);
check("price-band block is diagnosed separately", (e.getState().idleHint ?? "").includes("price band"));

e = runEngine({ momentumThresholdCents: 50 }, [flat, flat, flat, flat, flat]);
check("under-trigger block is diagnosed", (e.getState().idleHint ?? "").includes("momentum trigger"));

e = runEngine({ momentumThresholdCents: 3 }, [flat, flat, flat, flat, jump]);
check("a successful entry clears the hint", e.getState().idleHint === null);

// daily loss limit halts the engine
clearHistory();
const now = Date.now();
for (let i = 0; i < 3; i++) {
  const all = loadHistory();
  all.push({
    ticker: `KXLOSS${i}`, title: "loser", side: "yes", entryCents: 50, exitCents: 40,
    contracts: 10, pnlUsd: -10, openedAt: now, closedAt: now, reason: "stop-loss", dryRun: true,
  });
  fs.writeFileSync(path.join(dataDir(), "history.json"), JSON.stringify(all), "utf-8");
}
e = runEngine({ dailyLossLimitUsd: 25 }, [flat]);
check("daily loss limit halts the engine", e.getState().status === "stopped");
check("halt explains itself", (e.getState().haltedReason ?? "").includes("Daily loss limit"));

clearHistory();
e = runEngine({ dailyLossLimitUsd: 0 }, [flat]);
check("a zero limit disables the halt", e.getState().status === "running");

// ---------------------------------------------------------------- shutdown

/**
 * Regression for the crash in 1.1.0/1.1.1: closing the app while the engine ran
 * called engine.stop(), whose log line reached a listener that posted to an
 * already-destroyed webContents. The throw escaped as an uncaught exception and
 * Electron showed its blank "A JavaScript error occurred in the main process"
 * dialog. Main now guards the send; the engine must also survive a listener
 * that throws, so one bad subscriber cannot take the process down.
 */
section("shutdown");
reset();
{
  const bye = [mkt("KXBYE", 40, 41)];
  const byeUp = [mkt("KXBYE", 45, 46)];
  // Open a position first, so stop() has real work (and real log lines) to do.
  const e = runEngine({ momentumThresholdCents: 3 }, [bye, bye, bye, bye, byeUp]);
  check("shutdown case starts with a position open", e.getState().positions.length === 1);

  let stateCalls = 0;
  e.subscribe({
    onState: () => {
      stateCalls++;
      throw new Error("Object has been destroyed");
    },
    onLog: () => {
      throw new Error("Object has been destroyed");
    },
  });

  let threw = false;
  try {
    e.stop();
  } catch {
    threw = true;
  }
  check("stop() survives a listener that throws", !threw);
  check("the throwing listener was actually reached", stateCalls > 0);
  check("engine still reaches the stopped state", e.getState().status === "stopped");
}

// ---------------------------------------------------------------- factory reset

section("factory reset");
saveSettings({ ...DEFAULT_SETTINGS, tradeSizeUsd: 99 });
saveProfile("keepme", loadSettings());
saveCredentials({ apiKeyId: "WIPE-ME", apiPrivateKeyPem: PEM });
factoryReset();
check("reset restores default settings", loadSettings().tradeSizeUsd === DEFAULT_SETTINGS.tradeSizeUsd);
check("reset clears profiles", loadProfiles().length === 0);
check("reset clears history", loadHistory().length === 0);
check("reset clears the disclaimer", loadAppState().disclaimerAccepted === false);
check("reset deletes the credential vault", !fs.existsSync(path.join(dataDir(), "credentials.dat")));

// ---------------------------------------------------------------- result

console.log(`\n${"=".repeat(52)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
