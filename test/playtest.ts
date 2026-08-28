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
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TradingEngine } from "../electron/engine/engine";
import {
  KalshiApiError,
  KalshiClient,
  type KalshiMarket,
  type KalshiTrade,
} from "../electron/engine/kalshi";
import {
  DEFAULT_MODEL,
  FREE_MODELS,
  aiStatus,
  looksLikeKey,
  unsupportedNumbers,
} from "../electron/engine/ai";
import {
  clearTape,
  keepTrades,
  loadTape,
  loadTapeState,
  nextPollFrom,
  recordTrades,
  tapeInfo,
} from "../electron/engine/tape";
import { STRATEGIES, findStrategy } from "../electron/engine/strategies";
import {
  DEFAULT_SETTINGS,
  clearHistory,
  dataDir,
  deleteProfile,
  factoryReset,
  historyToCsv,
  loadAppState,
  loadEquity,
  loadHistory,
  loadProfiles,
  loadSettings,
  resetTradingData,
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
import {
  clearRecording,
  loadRecording,
  recordScan,
  recordingInfo,
  segmentScans,
} from "../electron/engine/recorder";
import { compareStrategies, runBacktest } from "../electron/engine/backtest";
import { runSweep } from "../electron/engine/sweep";
import {
  breakEvenWinRate,
  makerFeeCentsPerContract,
  makerFeeUsd,
  makerRate,
  minEfficientOrderSize,
  netEdgeCents,
  restAndSettleEdgeCents,
  roundTripFeeCentsPerContract,
  roundTripFeeUsd,
  settleBreakEvenPct,
  takerFeeCentsPerContract,
  takerFeeUsd,
} from "../electron/engine/fees";
import {
  MAX_TRIES,
  SETTLE_GRACE_MS,
  addPending,
  appendSettlement,
  clearSettlements,
  duePending,
  isSettled,
  loadPending,
  loadSettlements,
  prunePending,
  savePending,
  settlementInfo,
  sweepSettlements,
  type PendingMap,
} from "../electron/engine/settlements";
import { computeMetrics } from "../electron/engine/metrics";
import { splitAtGaps, sampledMs, CONTINUOUS_GAP_MS } from "../electron/engine/series";
import { lag1Autocorrelation } from "../electron/engine/engine";

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
check("passive recording defaults on", loadAppState().passiveRecording === true);
saveAppState({ ...loadAppState(), passiveRecording: false });
check("passive recording can be turned off", loadAppState().passiveRecording === false);

// ------------------------------------------------------------- equity series

/**
 * The equity chart used to join every point with one continuous line. On a
 * real file that drew a 9.5% profit across a thirty-hour gap the engine spent
 * switched off — the kind of picture this whole project exists not to draw.
 */
section("equity series gaps");

const MIN = 60_000;
check(
  "a continuous run is one stretch",
  splitAtGaps([{ ts: 0 }, { ts: 15_000 }, { ts: 30_000 }]).length === 1,
);
check(
  "an overnight pause splits the line",
  splitAtGaps([{ ts: 0 }, { ts: 15_000 }, { ts: 30 * 60 * MIN }, { ts: 30 * 60 * MIN + 15_000 }]).length === 2,
);
check(
  "a pause just under the threshold does not split",
  splitAtGaps([{ ts: 0 }, { ts: 179_000 }]).length === 1,
);
check(
  "a pause just over the threshold does split",
  splitAtGaps([{ ts: 0 }, { ts: 181_000 }]).length === 2,
);
check("an empty series has no stretches", splitAtGaps([]).length === 0);
check("a single point is one stretch", splitAtGaps([{ ts: 5 }]).length === 1);
check(
  "every point survives the split",
  splitAtGaps([{ ts: 0 }, { ts: 10 * MIN }, { ts: 10 * MIN + 1000 }]).flat().length === 3,
);

// Time running, not the width of the chart. These differ by a factor of
// thirteen on the file that prompted the fix, and only one is about trading.
check(
  "sampled time ignores the hole",
  sampledMs([{ ts: 0 }, { ts: 60_000 }, { ts: 30 * 60 * MIN }]) === 60_000 + CONTINUOUS_GAP_MS,
  `${sampledMs([{ ts: 0 }, { ts: 60_000 }, { ts: 30 * 60 * MIN }])}`,
);
check(
  "an unbroken hour reads as an hour",
  sampledMs(Array.from({ length: 241 }, (_, i) => ({ ts: i * 15_000 }))) === 60 * MIN,
);
check("sampled time of a single point is zero", sampledMs([{ ts: 99 }]) === 0);

// ---------------------------------------------------------------- strategies

section("strategy presets");
reset();
check("five presets ship", STRATEGIES.length === 5, `got ${STRATEGIES.length}`);
check("ids are unique", new Set(STRATEGIES.map((s) => s.id)).size === STRATEGIES.length);
check("unknown id is not found", findStrategy("nope") === undefined);
// Maker and taker entries are different trades, not different tunings — the
// maker pays no spread and no entry fee — so both mechanics must stay
// represented whatever else changes about the lineup.
check("both entry mechanics are offered", STRATEGIES.some((s) => s.params.makerEntries) && STRATEGIES.some((s) => !s.params.makerEntries));

// The fee band preset exists because the fee curve peaks at 50c; a band that
// contained the peak would be the preset arguing against its own reason.
const feeband = findStrategy("feeband");
check("fee band preset ships", feeband !== undefined);
check(
  "the fee band avoids the 50c fee peak",
  feeband !== undefined && feeband.params.minPriceCents > 50,
  feeband ? `min ${feeband.params.minPriceCents}c` : "missing",
);
check(
  "the fee band is cheaper to trade than the middle of the board",
  feeband !== undefined &&
    takerFeeCentsPerContract((feeband.params.minPriceCents + feeband.params.maxPriceCents) / 2) <
      takerFeeCentsPerContract(50),
);

for (const s of STRATEGIES) {
  // Not "take-profit beats stop", which is the folk rule and is wrong here.
  // Entry is at the ask and exit at the bid, so a position opens down the
  // spread: the price must move (tp + spread) to win but only (sl - spread)
  // to lose. A stop tighter than the target is therefore the losing side of a
  // trade before it starts. What actually has to hold is that a win clears
  // the fees — priced the way the preset actually enters — and that the stop
  // leaves room beyond the spread.
  const mid = Math.round((s.params.minPriceCents + s.params.maxPriceCents) / 2);
  check(
    `${s.name}: take-profit clears its fees`,
    netEdgeCents(s.params.takeProfitCents, mid, s.params.makerEntries) > s.params.minNetEdgeCents,
    `tp ${s.params.takeProfitCents}c at ${mid}c`,
  );
  check(
    `${s.name}: the stop leaves room past the spread`,
    s.params.stopLossCents > s.params.maxSpreadCents,
    `sl ${s.params.stopLossCents}c vs ${s.params.maxSpreadCents}c spread`,
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
function runEngine(
  settings: Partial<typeof DEFAULT_SETTINGS>,
  books: Mkt[][],
  stepMs = 15_000,
) {
  const e = new TradingEngine({
    ...DEFAULT_SETTINGS,
    // The scripted books reuse static objects whose volume never changes, so
    // the entry-quality gates (on by default in the app) would refuse every
    // handwritten entry here. The harness switches them off; the gates have
    // their own dedicated section, and any test that wants one passes it.
    momentumOnBid: false,
    requireTradeActivity: false,
    requireConsistentMove: false,
    ...settings,
  });
  const anyE = e as unknown as {
    status: string;
    setClock: (t: number) => void;
    processPendingOrders: (m: Mkt[]) => void;
    updatePositions: (m: Mkt[]) => void;
    scanForEntries: (m: Mkt[], t: number) => void;
    enforceDailyLossLimit: () => void;
    enforceLosingStreak: () => void;
    enforceMaxDrawdown: () => void;
  };
  anyE.status = "running";
  // One tick of clock per book, the way recorded scans carry their own
  // timestamps: cooldowns and lockouts in these tests expire on scan time,
  // exactly as they do in replays. A test that needs hours to pass hands in
  // a bigger step instead of hundreds of books.
  let clock = Date.now();
  for (const book of books) {
    // Mirrors the order in tick(); a step left out here passes in tests and
    // then does nothing (or something different) in the running app.
    anyE.setClock(clock);
    anyE.processPendingOrders(book);
    anyE.updatePositions(book);
    anyE.scanForEntries(book, clock);
    anyE.enforceDailyLossLimit();
    anyE.enforceLosingStreak();
    anyE.enforceMaxDrawdown();
    clock += stepMs;
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

// take-profit closes the trade and the cooldown stops it re-buying at the ask.
// A 4c target is under the default edge margin, so the margin is switched off
// here — these tests are about the exit, not the entry filter.
e = runEngine({ takeProfitCents: 4, minNetEdgeCents: 0, reentryCooldownSeconds: 90 }, [flat, flat, flat, flat, jump, [mkt("KXA", 52, 53)]]);
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
e = runEngine({ takeProfitCents: 4, minNetEdgeCents: 0, reentryCooldownSeconds: 0 }, [flat, flat, flat, flat, jump, [mkt("KXA", 52, 53)]]);
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

// ---------------------------------------------------------------- brakes

section("losing-streak brake");
reset();
{
  // Four losses in a row, newest last.
  const losses: TradeRecord[] = [1, 2, 3, 4].map((n) => ({
    ticker: `KXL-${n}`, title: "loss", side: "yes",
    entryCents: 50, exitCents: 46, contracts: 10, pnlUsd: -0.4,
    openedAt: Date.now() - n * 1000, closedAt: Date.now() - n * 900,
    reason: "stop-loss", dryRun: true,
  }));
  fs.writeFileSync(path.join(dataDir(), "history.json"), JSON.stringify(losses), "utf-8");

  const up = [mkt("KXS", 45, 46)];
  const flat2 = [mkt("KXS", 40, 41)];
  let e = runEngine({ maxConsecutiveLosses: 4 }, [flat2, flat2, flat2, flat2, up]);
  check("four losses in a row halts the engine", e.getState().status === "stopped");
  check(
    "the halt says why",
    (e.getState().haltedReason ?? "").includes("in a row"),
    e.getState().haltedReason ?? "",
  );
  check(
    "the halt names which ledger it counted",
    (e.getState().haltedReason ?? "").includes("paper"),
    e.getState().haltedReason ?? "",
  );

  e = runEngine({ maxConsecutiveLosses: 0 }, [flat2, flat2, flat2, flat2, up]);
  check("a zero limit disables the streak brake", e.getState().status === "running");

  e = runEngine({ maxConsecutiveLosses: 5 }, [flat2, flat2, flat2, flat2, up]);
  check("a streak under the limit does not halt", e.getState().status === "running");

  // A win between the losses breaks the streak, even with losses either side.
  const withWin = [...losses];
  withWin.splice(2, 0, { ...losses[0], ticker: "KXW", pnlUsd: 0.5, reason: "take-profit" });
  fs.writeFileSync(path.join(dataDir(), "history.json"), JSON.stringify(withWin), "utf-8");
  e = runEngine({ maxConsecutiveLosses: 4 }, [flat2, flat2, flat2, flat2, up]);
  check("a win breaks the streak", e.getState().status === "running");
}

section("paper and live are separate accounts");
reset();
{
  const now = Date.now();
  const trade = (dryRun: boolean, pnlUsd: number, n: number): TradeRecord => ({
    ticker: `KXSEP-${n}`, title: "t", side: "yes", entryCents: 50, exitCents: 45,
    contracts: 10, pnlUsd, openedAt: now - n * 1000, closedAt: now - n * 900,
    reason: "stop-loss", dryRun,
  });

  // A losing practice run: four paper losses well past a $25 daily limit.
  fs.writeFileSync(
    path.join(dataDir(), "history.json"),
    JSON.stringify([1, 2, 3, 4].map((n) => trade(true, -10, n))),
    "utf-8",
  );

  // Live mode: paper's losses must not arm the live brakes. Credentials are
  // supplied because isLive needs both the flag and a usable key.
  const liveCreds = { apiKeyId: "id", apiPrivateKeyPem: "pem" };
  const liveEngine = new TradingEngine(
    { ...DEFAULT_SETTINGS, liveMode: true, dailyLossLimitUsd: 25, maxConsecutiveLosses: 4 },
    liveCreds,
  );
  check("live mode is actually on for this case", liveEngine.getState().dryRun === false);
  check(
    "paper losses do not block a live start",
    liveEngine.blockedByBrakes() === null,
    liveEngine.blockedByBrakes() ?? "",
  );
  check("live scoreboard ignores paper trades", liveEngine.getState().allTimePnlUsd === 0);
  check("live win/loss counts ignore paper trades", liveEngine.getState().losses === 0);
  check("live today ignores paper trades", liveEngine.getState().todayPnlUsd === 0);

  // The same history in paper mode must still stop the engine — the brake is
  // not being weakened, only pointed at the right ledger.
  const paperEngine = new TradingEngine({
    ...DEFAULT_SETTINGS,
    dailyLossLimitUsd: 25,
    maxConsecutiveLosses: 4,
  });
  check("paper losses still block a paper start", paperEngine.blockedByBrakes() !== null);
  check("paper scoreboard sees its own trades", paperEngine.getState().allTimePnlUsd === -40);

  // And live losses must not leak the other way.
  fs.writeFileSync(
    path.join(dataDir(), "history.json"),
    JSON.stringify([1, 2, 3, 4].map((n) => trade(false, -10, n))),
    "utf-8",
  );
  const paper2 = new TradingEngine({
    ...DEFAULT_SETTINGS,
    dailyLossLimitUsd: 25,
    maxConsecutiveLosses: 4,
  });
  check("live losses do not block a paper start", paper2.blockedByBrakes() === null);
}

section("halts can be escaped");
reset();
{
  const now = Date.now();
  const losses: TradeRecord[] = [1, 2, 3, 4].map((n) => ({
    ticker: `KXHALT-${n}`, title: "t", side: "yes", entryCents: 50, exitCents: 45,
    contracts: 10, pnlUsd: -10, openedAt: now - n * 1000, closedAt: now - n * 900,
    reason: "stop-loss", dryRun: true,
  }));
  fs.writeFileSync(path.join(dataDir(), "history.json"), JSON.stringify(losses), "utf-8");

  // Before 1.7.1 start() cleared the banner and the first scan re-halted, so
  // the button looked dead. It must refuse up front instead.
  const e = new TradingEngine({ ...DEFAULT_SETTINGS, dailyLossLimitUsd: 25 });
  const refusals: { kind: string; title: string }[] = [];
  e.subscribe({ onState: () => {}, onLog: () => {}, onEvent: (ev) => refusals.push(ev) });
  check("a blocked engine refuses to start", (e.start(), e.getState().status === "stopped"));
  check(
    "the refusal names the way out",
    (e.getState().haltedReason ?? "").includes("Resume"),
    e.getState().haltedReason ?? "",
  );
  // From the tray there is no banner, so the refusal must also be an event —
  // that is what becomes the Windows toast.
  check(
    "the refusal raises an event for the tray",
    refusals.some((ev) => ev.kind === "halted" && ev.title.includes("did not start")),
    JSON.stringify(refusals),
  );

  // Resume: the limit is untouched, but its allowance restarts from now.
  e.clearHalt();
  check("resuming clears the banner", e.getState().haltedReason === null);
  check("resuming unblocks the brakes", e.blockedByBrakes() === null);
  check(
    "resuming does not weaken the limit",
    e.getState().status === "stopped" && loadSettings().dailyLossLimitUsd === DEFAULT_SETTINGS.dailyLossLimitUsd,
  );
  e.start();
  check("the engine starts after resuming", e.getState().status === "running");
  e.stop();

  // The acknowledgment must survive a restart, or closing the app resurrects
  // a halt the user already dealt with.
  const reopened = new TradingEngine({ ...DEFAULT_SETTINGS, dailyLossLimitUsd: 25 });
  check("the acknowledgment persists across a restart", reopened.blockedByBrakes() === null);

  // A fresh loss after acknowledging must halt again — the brake still works.
  const fresh = loadHistory();
  fresh.push({
    ticker: "KXHALT-NEW", title: "t", side: "yes", entryCents: 50, exitCents: 45,
    contracts: 10, pnlUsd: -30, openedAt: Date.now(), closedAt: Date.now() + 5,
    reason: "stop-loss", dryRun: true,
  });
  fs.writeFileSync(path.join(dataDir(), "history.json"), JSON.stringify(fresh), "utf-8");
  const after = new TradingEngine({ ...DEFAULT_SETTINGS, dailyLossLimitUsd: 25 });
  check("a new loss past the limit halts again", after.blockedByBrakes() !== null);

  // Raising the limit is the other way out, and the banner must follow.
  after.start();
  check("still blocked before the limit is raised", after.getState().haltedReason !== null);
  after.updateSettings({ ...DEFAULT_SETTINGS, dailyLossLimitUsd: 500 });
  check("raising the limit clears the stale banner", after.getState().haltedReason === null);
  after.start();
  check("and the engine starts", after.getState().status === "running");
  after.stop();
}

section("scoped clearing and reset");
reset();
{
  const now = Date.now();
  const mk = (dryRun: boolean, n: number): TradeRecord => ({
    ticker: `KXMIX-${n}`, title: "t", side: "yes", entryCents: 50, exitCents: 52,
    contracts: 10, pnlUsd: 0.2, openedAt: now, closedAt: now + n,
    reason: "take-profit", dryRun,
  });
  fs.writeFileSync(
    path.join(dataDir(), "history.json"),
    JSON.stringify([mk(true, 1), mk(false, 2), mk(true, 3)]),
    "utf-8",
  );

  clearHistory("paper");
  check("clearing paper keeps the live trades", loadHistory().length === 1);
  check("the survivor is the live one", loadHistory()[0].dryRun === false);

  fs.writeFileSync(
    path.join(dataDir(), "history.json"),
    JSON.stringify([mk(true, 1), mk(false, 2)]),
    "utf-8",
  );
  clearHistory("live");
  check("clearing live keeps the paper trades", loadHistory().length === 1 && loadHistory()[0].dryRun);

  clearHistory("all");
  check("clearing all empties it", loadHistory().length === 0);

  // The reset the user actually needs: results gone, credentials intact.
  saveCredentials({ apiKeyId: "KEEP-ME", apiPrivateKeyPem: PEM });
  saveSettings({ ...DEFAULT_SETTINGS, tradeSizeUsd: 77 });
  saveProfile("keep", loadSettings());
  fs.writeFileSync(path.join(dataDir(), "history.json"), JSON.stringify([mk(true, 1)]), "utf-8");
  recordScan([mkt("KXKEEP", 40, 41)]);

  resetTradingData();
  check("reset trading data clears history", loadHistory().length === 0);
  check("reset trading data clears equity", loadEquity().length === 0);
  check("reset trading data keeps the API key", loadCredentials().apiKeyId === "KEEP-ME");
  check("reset trading data keeps settings", loadSettings().tradeSizeUsd === 77);
  check("reset trading data keeps saved setups", loadProfiles().length === 1);
  check("reset trading data keeps the recording", recordingInfo().scans === 1);
}

section("trading hours");
reset();
{
  const at = (h: number) => new Date(2026, 7, 23, h, 30, 0);
  const engineWith = (s: Partial<typeof DEFAULT_SETTINGS>) =>
    new TradingEngine({ ...DEFAULT_SETTINGS, ...s });

  const off = engineWith({ tradingHoursEnabled: false, tradingStartHour: 9, tradingEndHour: 17 });
  check("disabled means always open", off.withinTradingHours(at(3)));

  const day = engineWith({ tradingHoursEnabled: true, tradingStartHour: 9, tradingEndHour: 17 });
  check("inside a daytime window", day.withinTradingHours(at(12)));
  check("before it opens", !day.withinTradingHours(at(8)));
  check("the start hour is included", day.withinTradingHours(at(9)));
  check("the end hour is excluded", !day.withinTradingHours(at(17)));
  check("after it closes", !day.withinTradingHours(at(22)));

  // 21:00 to 06:00 has to wrap past midnight rather than mean "never".
  const night = engineWith({ tradingHoursEnabled: true, tradingStartHour: 21, tradingEndHour: 6 });
  check("overnight: late evening is inside", night.withinTradingHours(at(23)));
  check("overnight: after midnight is inside", night.withinTradingHours(at(2)));
  check("overnight: the morning close is excluded", !night.withinTradingHours(at(6)));
  check("overnight: the afternoon is outside", !night.withinTradingHours(at(15)));

  const same = engineWith({ tradingHoursEnabled: true, tradingStartHour: 9, tradingEndHour: 9 });
  check("a zero-width window is ignored rather than blocking everything", same.withinTradingHours(at(3)));

  // And the gate must actually stop entries, not merely report.
  const up = [mkt("KXH", 45, 46)];
  const flat3 = [mkt("KXH", 40, 41)];
  const hour = new Date().getHours();
  const shut = runEngine(
    // A one-hour window on the opposite side of the clock is always shut now.
    { tradingHoursEnabled: true, tradingStartHour: (hour + 3) % 24, tradingEndHour: (hour + 4) % 24 },
    [flat3, flat3, flat3, flat3, up],
  );
  check("no entries while the window is shut", shut.getState().positions.length === 0);
  check("the scanner counts the clock skip", (shut.getState().scanner?.skippedClock ?? 0) > 0);
  check(
    "signals name the clock, not a spread",
    shut.getSignals().some((s) => s.reason.includes("outside trading hours")),
  );
  check(
    "the hint leads with the clock",
    (shut.getState().idleHint ?? "").includes("Outside your trading hours"),
  );
}

section("engine events");
reset();
{
  const events: { kind: string; tone: string }[] = [];
  // Direct construction, so the gate-off harness base does not apply — the
  // static books here have constant volume, which the shipped gate refuses.
  const e = new TradingEngine({
    ...DEFAULT_SETTINGS,
    momentumThresholdCents: 3,
    momentumOnBid: false,
    requireTradeActivity: false,
    requireConsistentMove: false,
  });
  e.subscribe({ onState: () => {}, onLog: () => {}, onEvent: (ev) => events.push(ev) });

  const anyE = e as unknown as {
    status: string;
    setClock: (t: number) => void;
    updatePositions: (m: Mkt[]) => void;
    scanForEntries: (m: Mkt[], t: number) => void;
  };
  anyE.status = "running";
  const flat4 = [mkt("KXE", 40, 41)];
  let evClock = Date.now();
  for (const b of [flat4, flat4, flat4, flat4, [mkt("KXE", 45, 46)]]) {
    anyE.setClock(evClock);
    anyE.updatePositions(b);
    anyE.scanForEntries(b, evClock);
    evClock += 15_000;
  }
  check("opening a position raises an event", events.some((x) => x.kind === "opened"));

  e.flatten();
  check("closing raises an event", events.some((x) => x.kind === "closed"));
  check("every event carries a tone", events.every((x) => x.tone.length > 0));

  // A subscriber with no onEvent must not crash the engine.
  const quiet = new TradingEngine({ ...DEFAULT_SETTINGS, requireConsistentMove: false });
  quiet.subscribe({ onState: () => {}, onLog: () => {} });
  let threwQuiet = false;
  try {
    quiet.flatten();
  } catch {
    threwQuiet = true;
  }
  check("a subscriber without onEvent is fine", !threwQuiet);
}

// ---------------------------------------------------------------- fees

section("Kalshi fees");
// ceil_to_cent(0.07 × C × P × (1−P)). At 50c with 20 contracts:
// 0.07 × 20 × 0.25 = $0.35 exactly.
check("fee at the 50c peak", takerFeeUsd(20, 50) === 0.35, `${takerFeeUsd(20, 50)}`);
check("the curve is symmetric", takerFeeUsd(20, 30) === takerFeeUsd(20, 70));
check("cheaper away from 50c", takerFeeUsd(20, 20) < takerFeeUsd(20, 50));
check("near-certain markets are cheapest", takerFeeUsd(20, 95) < takerFeeUsd(20, 20));
check("no contracts, no fee", takerFeeUsd(0, 50) === 0);
check("fees round up to the cent, never down", takerFeeUsd(1, 50) === 0.02, `${takerFeeUsd(1, 50)}`);

check(
  "a round trip is charged twice",
  roundTripFeeUsd(20, 50, 50) === 2 * takerFeeUsd(20, 50),
);
check(
  "round trip near 50c is about 3.5c per contract",
  Math.abs(roundTripFeeCentsPerContract(50) - 3.5) < 0.2,
  `${roundTripFeeCentsPerContract(50).toFixed(2)}c`,
);

// The reason the old 6c take-profit was a bad deal, stated as a test.
check("a 6c target barely clears the fee at 50c", netEdgeCents(6, 50) < 3);
check("a 12c target clears it with room", netEdgeCents(12, 50) > 8);
check("a 3c target cannot clear it at all", netEdgeCents(3, 50) < 0);

check(
  "a target under the fee has no break-even win rate",
  breakEvenWinRate(3, 5, 50) === null,
);
check(
  "the old 6c/4c defaults needed a very high win rate",
  (breakEvenWinRate(6, 4, 50) ?? 0) > 0.7,
  `${(((breakEvenWinRate(6, 4, 50) ?? 0) * 100)).toFixed(0)}%`,
);
check(
  "the new 12c/12c defaults need a plausible one",
  (breakEvenWinRate(12, 12, 50) ?? 1) < 0.68,
  `${(((breakEvenWinRate(12, 12, 50) ?? 0) * 100)).toFixed(0)}%`,
);

section("fees reach the ledger");
reset();
{
  // A position opened and closed at the same price must lose exactly the
  // round trip, not break even.
  const flat5 = [mkt("KXF", 40, 41)];
  const up5 = [mkt("KXF", 45, 46)];
  const e = runEngine({ momentumThresholdCents: 3, trailingStopCents: 0 }, [
    flat5, flat5, flat5, flat5, up5,
  ]);
  check("a position opened", e.getState().positions.length === 1);
  check(
    "it is already down the spread and both fees",
    e.getState().positions[0].unrealizedUsd < 0,
    `${e.getState().positions[0].unrealizedUsd}`,
  );
  check(
    "the entry fee is recorded on the position",
    e.getState().positions[0].entryFeeUsd > 0,
  );

  e.flatten();
  const closed = loadHistory();
  check("closing recorded a trade", closed.length === 1);
  check(
    "a flat round trip loses money rather than breaking even",
    closed.length > 0 && closed[0].pnlUsd < 0,
    `${closed[0]?.pnlUsd}`,
  );
}

section("trades that cannot win are refused");
reset();
{
  // 3c take-profit cannot clear a 3.5c round trip at any win rate.
  const flat6 = [mkt("KXG", 48, 49)];
  const up6 = [mkt("KXG", 53, 54)];
  const e = runEngine({ takeProfitCents: 3, momentumThresholdCents: 3 }, [
    flat6, flat6, flat6, flat6, up6,
  ]);
  check("no position is opened", e.getState().positions.length === 0);
  check("the scanner counts the refusal", (e.getState().scanner?.skippedFees ?? 0) > 0);
  check(
    "the signal explains it in cents",
    e.getSignals().some((s) => s.reason.includes("round-trip fee")),
    e.getSignals()[0]?.reason ?? "no signals",
  );
}

section("maker economics");
{
  // One taker execution at the 50c peak is half the round trip.
  check(
    "one side costs half the round trip",
    Math.abs(takerFeeCentsPerContract(50) * 2 - roundTripFeeCentsPerContract(50)) < 0.01,
  );
  check(
    "a maker entry keeps more of the same take-profit",
    netEdgeCents(6, 50, true) > netEdgeCents(6, 50, false),
  );
  // 6c minus ~1.75c one-sided vs 6c minus ~3.5c round trip.
  check("maker net edge is tp minus one fee", Math.abs(netEdgeCents(6, 50, true) - 4.25) < 0.1, `${netEdgeCents(6, 50, true)}`);
  check(
    "maker break-even win rate is lower",
    (breakEvenWinRate(12, 12, 50, true) ?? 1) < (breakEvenWinRate(12, 12, 50, false) ?? 0),
  );
  check(
    "a 3c target a taker cannot win, a maker can",
    netEdgeCents(3, 50, false) < 0 && netEdgeCents(3, 50, true) > 0,
  );
}

section("edge margin");
reset();
{
  // tp6 at ~49c clears the ~3.5c fee by ~2.5c. A 3c margin must refuse it;
  // the old bare "must clear at all" rule (margin 0) must still allow it.
  const flatE = [mkt("KXEDGE", 48, 49)];
  const upE = [mkt("KXEDGE", 53, 54)];
  let e = runEngine({ takeProfitCents: 6, minNetEdgeCents: 3 }, [flatE, flatE, flatE, flatE, upE]);
  check("a thin edge under the margin is refused", e.getState().positions.length === 0);
  check("the refusal is counted as a fee skip", (e.getState().scanner?.skippedFees ?? 0) > 0);
  check(
    "the signal names the margin",
    e.getSignals().some((s) => s.reason.includes("by under")),
    e.getSignals()[0]?.reason ?? "no signals",
  );

  e = runEngine({ takeProfitCents: 6, minNetEdgeCents: 0 }, [flatE, flatE, flatE, flatE, upE]);
  check("margin 0 keeps the old behaviour", e.getState().positions.length === 1);
}

section("maker order lifecycle");
reset();
{
  const flatM = [mkt("KXM", 40, 41)];
  const jumpM = [mkt("KXM", 45, 46)]; // rests a buy at the 45c bid
  const noFill = [mkt("KXM", 45, 46)]; // ask stays above the limit
  const fill = [mkt("KXM", 44, 45)]; // ask trades down to the limit

  // Placement: an eligible signal rests an order instead of crossing.
  let e = runEngine({ makerEntries: true, makerTtlTicks: 6 }, [flatM, flatM, flatM, flatM, jumpM]);
  let st = e.getState();
  check("an eligible signal rests an order, not a position", st.positions.length === 0 && st.pendingOrders.length === 1);
  check("the order rests at the bid", st.pendingOrders[0].limitCents === 45);
  check("cash is reserved for the order", st.cashUsd < DEFAULT_SETTINGS.dryRunCash);
  check(
    "equity is unchanged by reserving",
    Math.abs(st.equityUsd - DEFAULT_SETTINGS.dryRunCash) < 0.01,
    `${st.equityUsd}`,
  );
  check("a resting order raises no opened event yet", loadHistory().length === 0);

  // The bid being touched is not a fill; the ask has to trade down through it.
  e = runEngine({ makerEntries: true, makerTtlTicks: 6 }, [flatM, flatM, flatM, flatM, jumpM, noFill]);
  check("a touched bid alone does not fill", e.getState().positions.length === 0 && e.getState().pendingOrders.length === 1);

  // Fill: someone sells into the bid.
  e = runEngine({ makerEntries: true, makerTtlTicks: 6 }, [flatM, flatM, flatM, flatM, jumpM, fill]);
  st = e.getState();
  check("the ask reaching the limit fills the order", st.positions.length === 1 && st.pendingOrders.length === 0);
  check("the fill is at the limit price", st.positions[0].entryCents === 45);
  check("a maker fill pays no entry fee", st.positions[0].entryFeeUsd === 0);

  // A taker at the same moment is instantly down the spread and two fees; the
  // maker fill at the bid should be down only the coming exit fee.
  const takerAtSame = runEngine({ makerEntries: false }, [flatM, flatM, flatM, flatM, jumpM]);
  check(
    "a fresh maker fill is less underwater than a fresh taker entry",
    st.positions[0].unrealizedUsd > takerAtSame.getState().positions[0].unrealizedUsd,
    `maker ${st.positions[0].unrealizedUsd} vs taker ${takerAtSame.getState().positions[0].unrealizedUsd}`,
  );

  // Expiry: momentum decays before the TTL runs out, so nothing re-places.
  e = runEngine({ makerEntries: true, makerTtlTicks: 4 }, [
    flatM, flatM, flatM, flatM, jumpM, noFill, noFill, noFill, noFill,
  ]);
  st = e.getState();
  check("an unfilled order expires", st.pendingOrders.length === 0 && st.positions.length === 0);
  check(
    "expiry returns the reserved cash to the cent",
    st.cashUsd === DEFAULT_SETTINGS.dryRunCash,
    `${st.cashUsd}`,
  );

  // Resting orders occupy position slots — they are committed cash.
  const two = ["KXM1", "KXM2"].map((t) => mkt(t, 40, 41));
  const twoUp = ["KXM1", "KXM2"].map((t) => mkt(t, 45, 46));
  e = runEngine({ makerEntries: true, maxPositions: 1 }, [two, two, two, two, twoUp]);
  check("resting orders count toward the position cap", e.getState().pendingOrders.length === 1);

  // And a ticker with an order resting must not get a second one.
  e = runEngine({ makerEntries: true, makerTtlTicks: 8 }, [flatM, flatM, flatM, flatM, jumpM, [mkt("KXM", 46, 47)]]);
  check("no second order on the same ticker", e.getState().pendingOrders.length === 1);

  // Stopping the engine hands reserved cash back.
  e = runEngine({ makerEntries: true, makerTtlTicks: 8 }, [flatM, flatM, flatM, flatM, jumpM]);
  e.stop();
  check("stop() cancels resting orders and refunds", e.getState().cashUsd === DEFAULT_SETTINGS.dryRunCash);

  // Flatten cancels them too — "close everything" includes commitments.
  e = runEngine({ makerEntries: true, makerTtlTicks: 8 }, [flatM, flatM, flatM, flatM, jumpM]);
  e.flatten();
  check("flatten cancels resting orders", e.getState().pendingOrders.length === 0);

  // A maker in a runaway market never fills: the ask never comes back down.
  // Volume grows scan over scan so the replay runs the true shipped defaults,
  // traded-volume gate included.
  clearHistory();
  const ladder: { ts: number; markets: Mkt[] }[] = [];
  [40, 40, 40, 40, 45, 46, 47, 48, 50, 52].forEach((p, i) => {
    ladder.push({
      ts: Date.now() + i * 15000,
      markets: [{ ...mkt("KXL", p, p + 1), volume: 100 + i * 20 }],
    });
  });
  const makerRun = runBacktest(ladder as never, { ...DEFAULT_SETTINGS, makerEntries: true }, "maker");
  const takerRun = runBacktest(ladder as never, { ...DEFAULT_SETTINGS, requireConsistentMove: false }, "taker");
  check("a runaway market fills the taker, not the maker", takerRun.trades > 0 && makerRun.trades === 0);
  check("the unfilled maker run ends flat, not negative", makerRun.pnlUsd === 0);
  check(
    "the backtest counts the orders that never filled",
    makerRun.ordersPlaced > 0 && makerRun.ordersFilled === 0,
    `${makerRun.ordersFilled}/${makerRun.ordersPlaced}`,
  );
  check("a taker run reports no maker orders", takerRun.maker === false && takerRun.ordersPlaced === 0);
}

section("maker take-profit exits");
reset();
{
  const flat7 = [mkt("KXTP", 40, 41)];
  const jump7 = [mkt("KXTP", 45, 46)]; // taker entry at 46c, target 46+12 = 58c

  // Opening rests the sell at the target.
  let e = runEngine({ makerExits: true }, [flat7, flat7, flat7, flat7, jump7]);
  let p = e.getState().positions[0];
  check("opening rests a take-profit sell", p?.tpRestingCents === 58, `${p?.tpRestingCents}`);

  // A bid short of the target does not fill it — and does not trigger the
  // instant exit either, because the resting order owns the target now.
  e = runEngine({ makerExits: true }, [flat7, flat7, flat7, flat7, jump7, [mkt("KXTP", 57, 59)]]);
  check("a bid under the target leaves it resting", e.getState().positions.length === 1);

  // The bid paying up through the target fills at the target — not at the
  // gapped bid — and pays no exit fee.
  clearHistory();
  e = runEngine({ makerExits: true }, [flat7, flat7, flat7, flat7, jump7, [mkt("KXTP", 61, 63)]]);
  check("the bid crossing the target fills it", e.getState().positions.length === 0);
  const fill = loadHistory()[0];
  check("the fill is booked at the target", fill?.exitCents === 58, `${fill?.exitCents}`);
  check("the fill is labelled a maker exit", fill?.reason === "take-profit (maker)");
  // The whole win is gross minus the entry fee — the exit cost is zero.
  const expected =
    fill === undefined
      ? NaN
      : Math.round(((58 - 46) * fill.contracts - takerFeeUsd(fill.contracts, 46) * 100)) / 100;
  check(
    "a maker win pays no exit fee",
    fill !== undefined && fill.pnlUsd === expected,
    `${fill?.pnlUsd} vs ${expected}`,
  );

  // The taker route for the same move pays the exit fee — the whole point.
  clearHistory();
  e = runEngine({ makerExits: false }, [flat7, flat7, flat7, flat7, jump7, [mkt("KXTP", 61, 63)]]);
  const takerFill = loadHistory()[0];
  check(
    "the taker route nets less on the same move",
    takerFill !== undefined && fill !== undefined && takerFill.pnlUsd !== fill.pnlUsd,
    `maker ${fill?.pnlUsd} vs taker ${takerFill?.pnlUsd}`,
  );

  // A stop-loss clears the resting target and exits at market.
  clearHistory();
  e = runEngine({ makerExits: true }, [flat7, flat7, flat7, flat7, jump7, [mkt("KXTP", 30, 31)]]);
  check("a stop still fires with a target resting", e.getState().positions.length === 0);
  check("the stop is the exit of record", loadHistory()[0]?.reason === "stop-loss");

}

section("regime filter");
reset();
{
  // Perfectly alternating moves: lag-1 autocorrelation of the changes is -1.
  const zig = [40, 42, 40, 42, 40, 42, 40, 42, 40];
  const books = zig.map((p) => [mkt("KXZ", p, p + 1)]);
  const jumpZ = [mkt("KXZ", 45, 46)]; // clears the momentum trigger

  let e = runEngine({ regimeFilterEnabled: true }, [...books, jumpZ]);
  check("a chopping market is skipped when the filter is on", e.getState().positions.length === 0);
  check("the scanner counts the regime skip", (e.getState().scanner?.skippedRegime ?? 0) > 0);
  check(
    "the signal explains the regime",
    e.getSignals().some((s) => s.reason.includes("mean-revert")),
    e.getSignals()[0]?.reason ?? "no signals",
  );

  e = runEngine({ regimeFilterEnabled: false }, [...books, jumpZ]);
  check("the same market trades with the filter off", e.getState().positions.length === 1);

  // The statistic itself.
  check("alternating changes read as strongly negative", (lag1Autocorrelation(zig) ?? 0) < -0.5);
  const paired = [40, 41, 42, 44, 46, 47, 48, 50, 52]; // diffs 1,1,2,2,1,1,2,2
  check("persistent changes read as positive", (lag1Autocorrelation(paired) ?? -1) > 0);
  check("too little history returns null", lag1Autocorrelation([40, 41, 42]) === null);
  check("a flat series has no regime", lag1Autocorrelation([40, 40, 40, 40, 40, 40, 40, 40, 40, 40]) === null);
  // Reversed in 1.9.1, with evidence: this suite once required a five-sample
  // market to trade with the filter on. Both live loss clusters were fills
  // in markets the engine had known for about a minute — index ladders at
  // the futures open, crypto ladders at an hourly rollover. A filter that
  // refuses unjudgeable regimes must refuse the unjudged.
  {
    const young = runEngine({ regimeFilterEnabled: true }, [
      [mkt("KXS", 40, 41)], [mkt("KXS", 40, 41)], [mkt("KXS", 40, 41)], [mkt("KXS", 40, 41)],
      [mkt("KXS", 45, 46)],
    ]);
    check("a market seen for five scans is refused", young.getState().positions.length === 0);
    check(
      "— and told it is too new, not blamed for its regime",
      young.getSignals().some((s) => s.reason.includes("too new")),
      young.getSignals()[0]?.reason ?? "no signals",
    );
    check("the young skip counts as a regime skip", (young.getState().scanner?.skippedRegime ?? 0) > 0);

    // A quiet market that has been watched long enough and then wakes up is
    // the breakout a momentum rule exists for — flat history must still pass.
    const flatBooks = Array.from({ length: 9 }, () => [mkt("KXQ9", 40, 41)]);
    const wake = runEngine({ regimeFilterEnabled: true }, [...flatBooks, [mkt("KXQ9", 45, 46)]]);
    check("a well-observed flat market may still break out", wake.getState().positions.length === 1);

    // With the filter off, young markets trade as they always did.
    const off = runEngine({ regimeFilterEnabled: false }, [
      [mkt("KXS2", 40, 41)], [mkt("KXS2", 40, 41)], [mkt("KXS2", 40, 41)], [mkt("KXS2", 40, 41)],
      [mkt("KXS2", 45, 46)],
    ]);
    check("the filter off keeps the old behaviour", off.getState().positions.length === 1);
  }
}

section("entry-quality gates");
reset();
{
  // A seller pulling the ask lifts the mid by half the move — with nothing
  // traded. Under a permissive spread limit, mid momentum buys that lifted
  // ask; bid momentum sees a bid that never moved and refuses.
  const calm = [mkt("KXQ", 40, 41)];
  const askPull = [mkt("KXQ", 40, 49)]; // bid unchanged, ask +8, mid +4
  let e = runEngine({ maxSpreadCents: 10 }, [calm, calm, calm, calm, askPull]);
  check("mid momentum buys a pulled ask", e.getState().positions.length === 1);
  check(
    "— and pays the lifted ask for it",
    e.getState().positions[0]?.entryCents === 49,
    `${e.getState().positions[0]?.entryCents}`,
  );

  e = runEngine({ maxSpreadCents: 10, momentumOnBid: true }, [calm, calm, calm, calm, askPull]);
  check("bid momentum ignores a pulled ask", e.getState().positions.length === 0);

  const calm2 = [mkt("KXQ2", 40, 41)];
  const bidUp = [mkt("KXQ2", 45, 46)];
  e = runEngine({ momentumOnBid: true }, [calm2, calm2, calm2, calm2, bidUp]);
  check("a genuinely rising bid still triggers", e.getState().positions.length === 1);

  // The traded-volume gate: quotes moving without prints is not momentum.
  const mktV = (t: string, bid: number, ask: number, vol: number): Mkt => ({
    ...mkt(t, bid, ask),
    volume: vol,
    volume_24h: vol,
  });
  const q = [mktV("KXV", 40, 41, 100)];
  const jumpQuiet = [mktV("KXV", 45, 46, 100)]; // price up, nothing printed
  const jumpTraded = [mktV("KXV", 45, 46, 160)]; // price up, 60 contracts printed

  e = runEngine({ requireTradeActivity: true }, [q, q, q, q, jumpQuiet]);
  check("no prints in the window blocks entry", e.getState().positions.length === 0);
  check("the scanner counts the quiet skip", (e.getState().scanner?.skippedQuiet ?? 0) > 0);
  check(
    "the signal says quotes, not trades",
    e.getSignals().some((s) => s.reason.includes("quotes, not trades")),
    e.getSignals()[0]?.reason ?? "no signals",
  );

  e = runEngine({ requireTradeActivity: true }, [q, q, q, q, jumpTraded]);
  check("prints in the window allow the entry", e.getState().positions.length === 1);

  e = runEngine({ requireTradeActivity: false }, [q, q, q, q, jumpQuiet]);
  check("the gate off keeps the old behaviour", e.getState().positions.length === 1);
}

section("losing in a market locks it out");
reset();
{
  // A win cools down briefly and can be re-entered — same as always.
  const flatW = [mkt("KXLOCK", 40, 41)];
  const jumpW = [mkt("KXLOCK", 45, 46)];
  const winBook = [mkt("KXLOCK", 60, 61)]; // +14 past entry: take-profit
  const reJump = [mkt("KXLOCK", 66, 67)]; // fresh momentum right after
  let e = runEngine({ reentryCooldownSeconds: 90 }, [flatW, flatW, flatW, flatW, jumpW, winBook, reJump]);
  check(
    "a win cools down at the configured length",
    e.getSignals().some((s) => s.reason.includes("cooling down for")),
    e.getSignals()[0]?.reason ?? "no signals",
  );

  // A loss locks the ticker out for the hour, not for the cooldown.
  clearHistory();
  const lossBook = [mkt("KXLOCK", 30, 31)]; // −15 past entry: stop-loss
  const back = [mkt("KXLOCK", 30, 31)];
  const reUp = [mkt("KXLOCK", 35, 36)]; // momentum returns in the same market
  e = runEngine({ reentryCooldownSeconds: 90 }, [
    flatW, flatW, flatW, flatW, jumpW, lossBook, back, back, back, reUp,
  ]);
  check("the re-signal after a loss is refused", e.getState().positions.length === 0);
  check(
    "— and named as a lockout, in minutes",
    e.getSignals().some((s) => s.reason.includes("locked out") && s.reason.includes("m after losing")),
    e.getSignals()[0]?.reason ?? "no signals",
  );

  // The one-disproof rule never leaks to an unrelated series — only sibling
  // strikes of the same event share it, which has its own section below.
  clearHistory();
  const other = (bid: number, ask: number) => [mkt("KXLOCK", 30, 31), mkt("KXOTHER", bid, ask)];
  e = runEngine({ reentryCooldownSeconds: 90 }, [
    [mkt("KXLOCK", 40, 41), mkt("KXOTHER", 40, 41)],
    [mkt("KXLOCK", 40, 41), mkt("KXOTHER", 40, 41)],
    [mkt("KXLOCK", 40, 41), mkt("KXOTHER", 40, 41)],
    [mkt("KXLOCK", 40, 41), mkt("KXOTHER", 40, 41)],
    [mkt("KXLOCK", 45, 46), mkt("KXOTHER", 40, 41)],
    other(40, 41),
    other(45, 46),
  ]);
  check("an unrelated market still trades after the loss", e.getState().positions.length === 1);
  check("— and it is the other one", e.getState().positions[0]?.ticker === "KXOTHER");

  // Cooldown 0 still means churn is allowed, losses included.
  clearHistory();
  e = runEngine({ reentryCooldownSeconds: 0 }, [
    flatW, flatW, flatW, flatW, jumpW, lossBook, back, back, back, reUp,
  ]);
  check("cooldown 0 disables the lockout too", e.getState().positions.length === 1);
}

section("a climb is momentum; a jump is a head-fake");
reset();
{
  // Same 5c of net move, two shapes: a staircase and a single gapped tick.
  const stairs = [
    [mkt("KXCLIMB", 40, 41)], [mkt("KXCLIMB", 40, 41)], [mkt("KXCLIMB", 40, 41)],
    [mkt("KXCLIMB", 42, 43)], [mkt("KXCLIMB", 44, 45)], [mkt("KXCLIMB", 45, 46)],
  ];
  const gap = [
    [mkt("KXGAP", 40, 41)], [mkt("KXGAP", 40, 41)], [mkt("KXGAP", 40, 41)],
    [mkt("KXGAP", 40, 41)], [mkt("KXGAP", 40, 41)], [mkt("KXGAP", 45, 46)],
  ];
  let e = runEngine({ requireConsistentMove: true }, stairs);
  check("a staircase move enters", e.getState().positions.length === 1);

  e = runEngine({ requireConsistentMove: true }, gap);
  check("a single-jump move is refused", e.getState().positions.length === 0);
  check("the scanner counts the jumpy skip", (e.getState().scanner?.skippedJumpy ?? 0) > 0);
  check(
    "and the signal names the shape",
    e.getSignals().some((s) => s.reason.includes("one jump, not a climb")),
    e.getSignals()[0]?.reason ?? "no signals",
  );

  e = runEngine({ requireConsistentMove: false }, gap);
  check("the gate off keeps the old behaviour", e.getState().positions.length === 1);

  // The helper itself, at the edges.
  const cc = (xs: number[]) => TradingEngine.consistentClimb(xs);
  check("two rising steps of three pass, flat tail and all", cc([40, 42, 44, 44]));
  check("one rise with two flats fails", cc([40, 42, 42, 42]) === false);
  check("one jump then flat fails", cc([40, 45, 45, 45]) === false);
  check("all rising passes", cc([40, 41, 42, 43]));
  check("too short refuses", cc([40]) === false);
}

section("a stop that cannot fire is not a stop");
reset();
{
  // The exit rule waits for the bid to fall stopLossCents below entry, so
  // from an entry at or under that distance the trigger price is zero or
  // negative — unreachable. One live position rode 10c down to 1c for an
  // hour, −91% of cost, stop never firing.
  const cheapFlat = [mkt("KXDEAD", 7, 8)];
  const cheapJump = [mkt("KXDEAD", 11, 12)]; // ask 12 == default 12c stop
  let e = runEngine({}, [cheapFlat, cheapFlat, cheapFlat, cheapFlat, cheapJump]);
  check("an entry at the stop distance is refused", e.getState().positions.length === 0);
  check(
    "and the signal says the stop cannot fire",
    e.getSignals().some((s) => s.reason.includes("can never fire")),
    e.getSignals()[0]?.reason ?? "no signals",
  );
  check("it counts as a price skip", (e.getState().scanner?.skippedPrice ?? 0) > 0);

  // One cent above the distance the stop exists again, however thin.
  const liveFlat = [mkt("KXDEAD2", 8, 9)];
  const liveJump = [mkt("KXDEAD2", 12, 13)]; // ask 13 > 12c stop
  e = runEngine({}, [liveFlat, liveFlat, liveFlat, liveFlat, liveJump]);
  check("one cent of reachable stop admits the entry", e.getState().positions.length === 1);

  // A tighter stop moves the line with it.
  e = runEngine({ stopLossCents: 8 }, [cheapFlat, cheapFlat, cheapFlat, cheapFlat, cheapJump]);
  check("the gate tracks the configured stop", e.getState().positions.length === 1);
}

section("one event ladder is one bet");
reset();
{
  // Sibling strikes of one event — KXBTC-T50 and KXBTC-T30 both price the
  // same underlying. Half of the first two soak days' entries stacked a
  // ladder already held, and 18 of 34 stop-losses arrived in same-ladder
  // cascades: five adjacent BTC strikes won together, then four of them
  // stopped out inside three minutes and tripped the losing-streak brake
  // with what was one market move.
  const lad = (a: [number, number], b: [number, number], oth?: [number, number]) => {
    const books = [mkt("KXBTC-T50", a[0], a[1]), mkt("KXBTC-T30", b[0], b[1])];
    if (oth) books.push(mkt("KXOTH", oth[0], oth[1]));
    return books;
  };
  const flatL = lad([40, 41], [40, 41], [40, 41]);
  const jumpL = lad([45, 46], [45, 46], [45, 46]);
  let e = runEngine({}, [flatL, flatL, flatL, flatL, jumpL]);
  check(
    "the default cap holds one strike per ladder",
    e.getState().positions.filter((p) => p.ticker.startsWith("KXBTC")).length === 1,
  );
  check(
    "an unrelated market still enters alongside it",
    e.getState().positions.some((p) => p.ticker === "KXOTH"),
  );
  check("the scanner counts the ladder skip", (e.getState().scanner?.skippedEvent ?? 0) > 0);
  check(
    "and says why",
    e.getSignals().some((s) => s.reason.includes("sibling strikes are the same bet")),
    e.getSignals()[0]?.reason ?? "no signals",
  );

  // Raising the cap admits the second strike; a third sibling still waits.
  clearHistory();
  const three = (n: number) => [
    mkt("KXBTC-T50", n, n + 1), mkt("KXBTC-T30", n, n + 1), mkt("KXBTC-T20", n, n + 1),
  ];
  e = runEngine({ maxPositionsPerEvent: 2 }, [three(40), three(40), three(40), three(40), three(45)]);
  check("a cap of two admits two strikes, not three", e.getState().positions.length === 2);

  // A resting maker order holds the ladder slot the moment it is placed.
  clearHistory();
  e = runEngine({ makerEntries: true }, [flatL, flatL, flatL, flatL, jumpL]);
  const st = e.getState();
  check(
    "a resting order counts toward the ladder cap",
    st.pendingOrders.filter((o) => o.ticker.startsWith("KXBTC")).length === 1 &&
      st.positions.filter((p) => p.ticker.startsWith("KXBTC")).length === 0,
    `pending ${st.pendingOrders.length}, open ${st.positions.length}`,
  );

  // A stop-loss on one strike locks the whole ladder, not just its own line.
  // The evening this rule comes from: the engine stopped out of three BTC
  // strikes and then bought a fourth 45 seconds later, into the same dip.
  clearHistory();
  const lossT50 = lad([30, 31], [45, 46]); // T50 crashes through its stop
  const reT30 = lad([30, 31], [50, 51]); // fresh momentum on the sibling
  e = runEngine({}, [
    lad([40, 41], [40, 41]), lad([40, 41], [40, 41]), lad([40, 41], [40, 41]),
    lad([40, 41], [40, 41]), lad([45, 46], [45, 46]), lossT50, reT30,
  ]);
  check("a sibling's loss refuses the whole ladder", e.getState().positions.length === 0);
  check(
    "and the signal blames the ladder",
    e.getSignals().some((s) => s.reason.includes("ladder stopped out")),
    e.getSignals()[0]?.reason ?? "no signals",
  );

  // The ladder lock expires on scan time — 45-minute steps, so the sibling
  // is still locked one book after the loss and free two books after.
  clearHistory();
  const reT30More = lad([30, 31], [55, 56]);
  e = runEngine(
    {},
    [
      lad([40, 41], [40, 41]), lad([40, 41], [40, 41]), lad([40, 41], [40, 41]),
      lad([40, 41], [40, 41]), lad([45, 46], [45, 46]), lossT50, reT30, reT30More,
    ],
    45 * 60_000,
  );
  check(
    "the ladder lock expires on the scan clock",
    e.getState().positions.some((p) => p.ticker === "KXBTC-T30"),
    e.getState().positions.map((p) => p.ticker).join(",") || "no positions",
  );

  // A win never locks the ladder: strength continuing into the next strike
  // is a different claim from a stop-out disproving it.
  clearHistory();
  const winT50 = lad([60, 61], [45, 46]); // T50 through its take-profit
  const jumpT30 = lad([60, 61], [55, 56]);
  e = runEngine({}, [
    lad([40, 41], [40, 41]), lad([40, 41], [40, 41]), lad([40, 41], [40, 41]),
    lad([40, 41], [40, 41]), lad([45, 46], [45, 46]), winT50, jumpT30,
  ]);
  check(
    "a sibling's win leaves the ladder open",
    e.getState().positions.some((p) => p.ticker === "KXBTC-T30"),
    e.getState().positions.map((p) => p.ticker).join(",") || "no positions",
  );
}

section("cooldowns run on the scan clock");
reset();
{
  // The regression this section pins down: cooldowns used to be set and
  // checked against Date.now(), so inside a replay — where an hour of market
  // time passes in seconds of wall time — no cooldown ever expired and no
  // lockout ever ended. Sixty-second steps here mean the whole run takes
  // milliseconds of wall time; only the scan clock can admit the re-entry.
  const f = [mkt("KXCLK", 40, 41)];
  const e = runEngine(
    { reentryCooldownSeconds: 90 },
    [f, f, f, f, [mkt("KXCLK", 45, 46)], [mkt("KXCLK", 60, 61)],
      [mkt("KXCLK", 66, 67)], [mkt("KXCLK", 72, 73)]],
    60_000,
  );
  check(
    "a win cooldown expires on scan time, not wall time",
    e.getState().positions.length === 1,
    `positions ${e.getState().positions.length}`,
  );
}

section("risk-balanced sizing");
reset();
{
  // The first live soak's worst trade: $10 at 15c bought 66 contracts, so a
  // 12c stop cost $7.92 instead of the $2.40 it costs at 50c. The risk cap
  // must equalise the stop-out cost across the price range.
  const cheapFlat = [mkt("KXCHEAP", 14, 15)];
  const cheapJump = [mkt("KXCHEAP", 19, 20)];
  let e = runEngine({}, [cheapFlat, cheapFlat, cheapFlat, cheapFlat, cheapJump]);
  let p = e.getState().positions[0];
  check("a cheap strike opens", p !== undefined);
  check("— but cannot out-risk a mid-price trade", p.contracts === 20, `${p?.contracts} contracts`);
  check(
    "a stop-out is bounded to a quarter of the trade size",
    (p.contracts * DEFAULT_SETTINGS.stopLossCents) / 100 <= DEFAULT_SETTINGS.tradeSizeUsd * 0.25 + 0.01,
    `$${((p.contracts * DEFAULT_SETTINGS.stopLossCents) / 100).toFixed(2)} at risk`,
  );

  // Mid-price sizing must be exactly what it always was — the cap only
  // trims the tails.
  const midFlat = [mkt("KXMID", 50, 51)];
  const midJump = [mkt("KXMID", 55, 56)];
  e = runEngine({}, [midFlat, midFlat, midFlat, midFlat, midJump]);
  p = e.getState().positions[0];
  check("mid-price sizing is unchanged", p?.contracts === 17, `${p?.contracts} contracts`);

  // A wide stop also risks more per contract, so it sizes down too.
  e = runEngine({ stopLossCents: 25, takeProfitCents: 26 }, [midFlat, midFlat, midFlat, midFlat, midJump]);
  p = e.getState().positions[0];
  check(
    "a wide stop trades smaller for the same risk",
    p !== undefined && p.contracts === 10,
    `${p?.contracts} contracts`,
  );
}

section("the endgame entry cutoff");
reset();
{
  const now = Math.floor(Date.now() / 1000);
  const at = (ticker: string, bid: number, ask: number, closeInS: number) => ({
    ...mkt(ticker, bid, ask),
    close_ts: now + closeInS,
  });

  // Ten minutes to close, default 30-minute cutoff: no entry, and the
  // signal says why.
  const soonFlat = [at("KXSOON", 40, 41, 600)];
  const soonJump = [at("KXSOON", 45, 46, 600)];
  let e = runEngine({}, [soonFlat, soonFlat, soonFlat, soonFlat, soonJump]);
  check("a market near its close is refused", e.getState().positions.length === 0);
  check("the scanner counts the closing skip", (e.getState().scanner?.skippedClosing ?? 0) > 0);
  check(
    "the signal names the cutoff",
    e.getSignals().some((s) => s.reason.includes("entry cutoff")),
    e.getSignals()[0]?.reason ?? "no signals",
  );

  // Ninety minutes out clears the default cutoff.
  const farFlat = [at("KXFAR", 40, 41, 5400)];
  const farJump = [at("KXFAR", 45, 46, 5400)];
  e = runEngine({}, [farFlat, farFlat, farFlat, farFlat, farJump]);
  check("a market with time left still trades", e.getState().positions.length === 1);

  // Old recordings carry no close time; unknown must pass, not guess.
  const bare = [mkt("KXOLD", 40, 41)];
  const bareUp = [mkt("KXOLD", 45, 46)];
  e = runEngine({}, [bare, bare, bare, bare, bareUp]);
  check("an unknown close time is let through", e.getState().positions.length === 1);

  // 0 disables the gate entirely.
  e = runEngine({ minMinutesToClose: 0 }, [soonFlat, soonFlat, soonFlat, soonFlat, soonJump]);
  check("0 disables the cutoff", e.getState().positions.length === 1);

  // The gate must run on the scan's clock, not the wall clock. A recording
  // is entirely in the past, so measuring against Date.now() marked every
  // recorded market "closing soon" and silently zeroed every backtest of
  // data that carried close times. The tell was trade counts shrinking as
  // the recording grew.
  const t0 = Date.now() - 7 * 24 * 3600_000; // a week-old recording
  const oldScan = (i: number, bid: number, ask: number, closeInS: number) => ({
    ts: t0 + i * 15000,
    markets: [{ ...mkt("KXPAST", bid, ask), volume: 100 + i * 20, close_ts: Math.floor(t0 / 1000) + closeInS }],
  });
  const oldScans = [
    oldScan(0, 40, 41, 5400), oldScan(1, 40, 41, 5400), oldScan(2, 40, 41, 5400),
    oldScan(3, 40, 41, 5400), oldScan(4, 45, 46, 5400),
  ];
  const past = runBacktest(oldScans as never, { ...DEFAULT_SETTINGS, requireConsistentMove: false }, "past");
  check("an old recording with time to close still trades", past.trades > 0, `${past.trades} trades`);

  const oldSoon = [
    oldScan(0, 40, 41, 600), oldScan(1, 40, 41, 600), oldScan(2, 40, 41, 600),
    oldScan(3, 40, 41, 600), oldScan(4, 45, 46, 600),
  ];
  const pastSoon = runBacktest(oldSoon as never, { ...DEFAULT_SETTINGS, requireConsistentMove: false }, "past-soon");
  check("— while its genuinely near-close markets are still refused", pastSoon.trades === 0);
}

section("drawdown brake");
reset();
{
  const flatD = [mkt("KXD", 50, 51)];
  const upD = [mkt("KXD", 55, 56)];
  const crash = [mkt("KXD", 30, 31)];

  // A $50 position falling 26c realises far more than 5% of $100 equity.
  let e = runEngine({ tradeSizeUsd: 50, maxDrawdownPct: 5, dailyLossLimitUsd: 0 }, [
    flatD, flatD, flatD, flatD, upD, crash,
  ]);
  check("a deep drawdown halts the engine", e.getState().status === "stopped");
  check(
    "the halt names the drawdown",
    (e.getState().haltedReason ?? "").includes("session peak"),
    e.getState().haltedReason ?? "",
  );

  e = runEngine({ tradeSizeUsd: 50, maxDrawdownPct: 0, dailyLossLimitUsd: 0, maxConsecutiveLosses: 0 }, [
    flatD, flatD, flatD, flatD, upD, crash,
  ]);
  check("0 disables the drawdown brake", e.getState().status === "running");

  // Sizing scales down as drawdown grows, and never below a quarter.
  type Sizeable = { sizeFactor: () => number; peakEquityUsd: number; cashUsd: number };
  const fresh = new TradingEngine({ ...DEFAULT_SETTINGS, maxDrawdownPct: 20 }) as unknown as Sizeable;
  check("no drawdown, full size", fresh.sizeFactor() === 1);
  fresh.peakEquityUsd = 100;
  fresh.cashUsd = 90; // 10% down against a 20% limit
  const scaled = fresh.sizeFactor();
  check("halfway to the limit trades smaller", scaled < 1 && scaled > 0.25, `${scaled}`);
  fresh.cashUsd = 10; // 90% down — beyond the limit
  check("the floor is a quarter of normal size", fresh.sizeFactor() === 0.25);
  const off = new TradingEngine({ ...DEFAULT_SETTINGS, maxDrawdownPct: 0 }) as unknown as Sizeable;
  off.peakEquityUsd = 100;
  off.cashUsd = 10;
  check("scaling is off when the brake is off", off.sizeFactor() === 1);
}

section("performance metrics");
{
  const t = (pnlUsd: number): TradeRecord => ({
    ticker: "KXPM", title: "m", side: "yes", entryCents: 50, exitCents: 50,
    contracts: 10, pnlUsd, openedAt: 0, closedAt: 0, reason: "test", dryRun: true,
  });
  const eq = (vals: number[]) => vals.map((v, i) => ({ ts: i, equityUsd: v }));

  const m = computeMetrics([t(2), t(2), t(-1), t(-1), t(2)], eq([100, 102, 104, 103, 102, 104]));
  check("profit factor is gross win over gross loss", m.profitFactor === 3, `${m.profitFactor}`);
  check("expectancy is mean P&L per trade", m.expectancyUsd === 0.8, `${m.expectancyUsd}`);
  check("win rate counts only decided trades", m.winRate === 0.6);
  check("payoff ratio is avg win over avg loss", m.payoffRatio === 2, `${m.payoffRatio}`);
  check("sharpe is mean over spread", Math.abs((m.sharpePerTrade ?? 0) - 0.544) < 0.01, `${m.sharpePerTrade}`);
  check("sortino only counts downside as risk", (m.sortinoPerTrade ?? 0) > (m.sharpePerTrade ?? 0));
  check("streaks are tracked", m.longestWinStreak === 2 && m.longestLossStreak === 2);
  check("drawdown from the equity curve", m.maxDrawdownUsd === 2, `${m.maxDrawdownUsd}`);

  const empty = computeMetrics([], []);
  check("no trades yields nulls, not zeros pretending to be results",
    empty.profitFactor === null && empty.expectancyUsd === null && empty.sharpePerTrade === null);

  const allWins = computeMetrics([t(1), t(2)], eq([100, 101, 103]));
  check("all wins has no profit factor rather than infinity", allWins.profitFactor === null);
  check("all wins still has an expectancy", allWins.expectancyUsd === 1.5);

  // A losing strategy must read as one on every metric that has a sign.
  const losing = computeMetrics([t(-1), t(-2), t(1), t(-2)], eq([100, 99, 97, 98, 96]));
  check("a losing run has negative expectancy", (losing.expectancyUsd ?? 0) < 0);
  check("a losing run has PF under 1", (losing.profitFactor ?? 9) < 1);
  check("a losing run has negative sharpe", (losing.sharpePerTrade ?? 0) < 0);

  // And the backtester carries them.
  const scans: { ts: number; markets: Mkt[] }[] = [];
  [40, 40, 40, 40, 45, 46, 47, 48, 50, 52].forEach((p, i) => {
    scans.push({
      ts: Date.now() + i * 15000,
      markets: [{ ...mkt("KXMM", p, p + 1), volume: 100 + i * 20 }],
    });
  });
  const bt = runBacktest(scans as never, { ...DEFAULT_SETTINGS, requireConsistentMove: false }, "metrics");
  check("backtests report metrics", bt.metrics.trades === bt.trades);
}

section("new settings survive sanitising");
reset();
{
  saveSettings({
    ...DEFAULT_SETTINGS,
    makerTtlTicks: 0,
    minNetEdgeCents: -5,
    maxDrawdownPct: 200,
    makerEntries: "yes" as never,
    momentumOnBid: 1 as never,
    requireTradeActivity: undefined as never,
  });
  const s = loadSettings();
  check("maker TTL floors at one scan", s.makerTtlTicks === 1, `${s.makerTtlTicks}`);
  check("edge margin floors at zero", s.minNetEdgeCents === 0, `${s.minNetEdgeCents}`);
  check("drawdown limit is capped", s.maxDrawdownPct === 95, `${s.maxDrawdownPct}`);
  check("maker flag coerces to boolean", s.makerEntries === true);
  check("bid-momentum flag coerces to boolean", s.momentumOnBid === true);
  check("a missing gate flag reads as off", s.requireTradeActivity === false);
}

// ---------------------------------------------------------------- backtest

section("recording");
reset();
clearRecording();
check("no recording on a fresh install", recordingInfo().exists === false);
check("an absent recording replays as nothing", loadRecording().length === 0);

recordScan([mkt("KXR", 40, 41), mkt("KXR2", 50, 51)]);
recordScan([mkt("KXR", 41, 42), mkt("KXR2", 50, 51)]);
let rec = recordingInfo();
check("scans are counted", rec.scans === 2, `${rec.scans}`);
check("the recording reports a size", rec.bytes > 0);
check("it knows when it started and ended", rec.firstTs !== null && rec.lastTs !== null);
check("an empty sweep is not recorded", (recordScan([]), recordingInfo().scans === 2));

const loaded = loadRecording();
check("scans round-trip", loaded.length === 2);
check("markets survive the round-trip", loaded[0].markets.length === 2);
check("prices survive the round-trip", loaded[1].markets[0].yes_bid === 41);

// The process can be killed mid-append, so a torn last line must not poison
// the whole replay.
fs.appendFileSync(path.join(dataDir(), "scans.jsonl"), '{"ts":1,"markets":[{"tick', "utf-8");
check("a torn final line is skipped, not fatal", loadRecording().length === 2);

// ...and it must not poison the *summary* either. recordingInfo parsed the
// last line to find the end timestamp, so the one condition loadRecording is
// built to tolerate made the whole recording report as empty — which on the
// Backtest page disables both buttons and says there is no recording at all.
const torn = recordingInfo();
check("a torn final line still reports the recording exists", torn.exists === true);
check("a torn final line does not zero the scan count", torn.scans > 0, `${torn.scans}`);
check("the start timestamp survives a torn last line", torn.firstTs !== null);
check("the end timestamp falls back to the last good line", torn.lastTs !== null);
check("a torn final line still reports a size", torn.bytes > 0, `${torn.bytes}`);

clearRecording();
check("clearing removes the recording", recordingInfo().exists === false);

section("recording seams");
reset();
{
  const t0 = 1_700_000_000_000;
  const scan = (ts: number, bid: number, ask: number, vol: number) => ({
    ts,
    markets: [{ ...mkt("KXSEAM", bid, ask), volume: vol }],
  });

  // segmentScans itself.
  const contiguous = [0, 1, 2, 3, 4, 5].map((i) => scan(t0 + i * 15000, 40, 41, 100 + i));
  check("a contiguous recording is one segment", segmentScans(contiguous as never).length === 1);

  const gapped = [
    ...[0, 1, 2, 3, 4].map((i) => scan(t0 + i * 15000, 40, 41, 100 + i * 20)),
    ...[0, 1, 2, 3, 4].map((i) => scan(t0 + 3_600_000 + i * 15000, 45, 46, 300 + i * 20)),
  ];
  check("a gap splits the recording in two", segmentScans(gapped as never).length === 2);
  check(
    "a stub segment is dropped",
    segmentScans([...contiguous, scan(t0 + 7_200_000, 50, 51, 500)] as never).length === 1,
  );
  check("an empty recording yields no segments", segmentScans([]).length === 0);

  // The defence the splitting exists for: prices jump 5c across an hour-long
  // seam. Unsegmented, that seam reads as one 15-second momentum burst and
  // the replay buys it; segmented, each side is quiet and nothing trades.
  const seamResult = runBacktest(gapped as never, { ...DEFAULT_SETTINGS, requireConsistentMove: false }, "seam");
  check("a seam jump is not traded as momentum", seamResult.trades === 0, `${seamResult.trades} trades`);

  // The same 5c move without the gap is genuine momentum and must still trade
  // — the splitting must not neuter the replay.
  const genuine = [
    ...[0, 1, 2, 3, 4].map((i) => scan(t0 + i * 15000, 40, 41, 100 + i * 20)),
    ...[5, 6, 7, 8, 9].map((i) => scan(t0 + i * 15000, 45, 46, 100 + i * 20)),
  ];
  const genuineResult = runBacktest(genuine as never, { ...DEFAULT_SETTINGS, requireConsistentMove: false }, "genuine");
  check("the same move without a gap still trades", genuineResult.trades > 0);
  check(
    "an end-of-recording close says so",
    (genuineResult.exitReasons["recording ended"] ?? 0) > 0,
    JSON.stringify(genuineResult.exitReasons),
  );
}

// ------------------------------------------------------------- maker fees

section("the maker side is free, and the code has to know it");
{
  // The whole rest-and-settle case rests on this number being zero rather
  // than merely small, so it is asserted rather than commented.
  check(
    "a quadratic series charges makers nothing",
    makerFeeUsd(100, 50, "quadratic") === 0,
    `${makerFeeUsd(100, 50, "quadratic")}`,
  );
  check(
    "...at every price, not just the middle",
    [5, 25, 50, 75, 85, 95].every((p) => makerFeeUsd(500, p, "quadratic") === 0),
  );
  check("...and the taker side still is not", takerFeeUsd(100, 50) > 1.7);

  // Series that do charge makers must charge the published fraction.
  const takerMid = takerFeeUsd(1000, 50);
  const makerMid = makerFeeUsd(1000, 50, "quadratic_with_maker_fees");
  check(
    "a maker-fee series charges a quarter of the taker rate",
    Math.abs(makerMid / takerMid - 0.25) < 0.01,
    `${makerMid} vs ${takerMid}`,
  );
  const comboMid = makerFeeUsd(1000, 50, "quadratic_with_combo_maker_fees");
  check(
    "the combo tier charges half",
    Math.abs(comboMid / takerMid - 0.5) < 0.01,
    `${comboMid} vs ${takerMid}`,
  );

  // The one mistake this file must never make is inventing a zero.
  check(
    "an unknown fee_type falls back to the full taker rate",
    makerRate("some_tier_invented_next_year") === makerRate("quadratic_with_maker_fees") * 4,
  );
  check(
    "...so an unrecognised series is never treated as free",
    makerFeeUsd(100, 50, "flat") > 0,
    `${makerFeeUsd(100, 50, "flat")}`,
  );

  // Rounding precision decides whether small orders are viable at all.
  check(
    "centicent rounding is cheaper than cent rounding on one contract",
    takerFeeUsd(1, 85, "centicent") < takerFeeUsd(1, 85, "cent"),
    `${takerFeeUsd(1, 85, "centicent")} vs ${takerFeeUsd(1, 85, "cent")}`,
  );
  check(
    "cent rounding makes a single contract cost a whole cent",
    takerFeeUsd(1, 85, "cent") === 0.01,
    `${takerFeeUsd(1, 85, "cent")}`,
  );
  check(
    "a cent-rounded account needs a batch before the rate is honest",
    minEfficientOrderSize(85, "cent") > 1,
    `${minEfficientOrderSize(85, "cent")}`,
  );
  check("a centicent account does not", minEfficientOrderSize(85, "centicent") === 1);

  // What a held-to-settlement position actually has to beat.
  check(
    "on a zero-maker series the bar is exactly the price paid",
    settleBreakEvenPct(85, "quadratic") === 85,
    `${settleBreakEvenPct(85, "quadratic")}`,
  );
  check(
    "a maker-charging series raises the bar",
    settleBreakEvenPct(85, "quadratic_with_maker_fees") > 85,
    `${settleBreakEvenPct(85, "quadratic_with_maker_fees")}`,
  );
  check(
    "buying an 85c favourite that lands 87% of the time earns two cents",
    Math.abs(restAndSettleEdgeCents(85, 87) - 2) < 1e-9,
    `${restAndSettleEdgeCents(85, 87)}`,
  );
  check(
    "buying one that lands 83% of the time loses two",
    restAndSettleEdgeCents(85, 83) < 0,
    `${restAndSettleEdgeCents(85, 83)}`,
  );
  check("a maker execution on the ladders costs nothing per contract", makerFeeCentsPerContract(85) === 0);

  // The comparison that motivated all of this: the same trade, taken versus
  // rested. A round trip at 50c is the worst point on the curve.
  check(
    "a taker round trip at 50c costs more than three cents a contract",
    roundTripFeeCentsPerContract(50) > 3,
    `${roundTripFeeCentsPerContract(50)}`,
  );
}

// --------------------------------------------------------- settlement outcomes

section("collecting what markets actually settled at");
reset();
clearSettlements();
{
  check("an open market reports no result", isSettled("") === false);
  check("whitespace is not a result either", isSettled("   ") === false);
  check("yes is a result", isSettled("yes") === true);
  check("so is void", isSettled("void") === true);

  const closeTs = 1_700_000_000; // unix seconds
  const closeMs = closeTs * 1000;
  const m = (ticker: string, close: number): KalshiMarket =>
    ({ ...mkt(ticker, 50, 51), close_ts: close }) as KalshiMarket;

  let pending: PendingMap = addPending({}, [m("KXA", closeTs), m("KXB", closeTs + 600)]);
  check("markets are remembered so their outcome can be collected", Object.keys(pending).length === 2);

  pending = addPending(pending, [m("KXC", 0)]);
  check("a market with no close time cannot be scheduled and is skipped", pending.KXC === undefined);

  // A market seen on a hundred consecutive sweeps must not have its retry
  // counter reset a hundred times, or it would be asked about forever.
  pending.KXA = { ...pending.KXA, tries: 4, lastTry: 0 };
  pending = addPending(pending, [m("KXA", closeTs)]);
  check("re-seeing a market does not reset its retry count", pending.KXA.tries === 4);

  check(
    "a market is not asked about before it closes",
    duePending(pending, closeMs - 1000).length === 0,
  );
  check(
    "...nor immediately after, since Kalshi resolves a few minutes late",
    duePending(pending, closeMs + 1000).length === 0,
  );
  const due = duePending({ KXA: { closeTs, tries: 0, lastTry: 0 } }, closeMs + SETTLE_GRACE_MS + 1);
  check("...but it is once the grace period is up", due.length === 1 && due[0] === "KXA");

  check(
    "a market asked about a moment ago is not asked again immediately",
    duePending(
      { KXA: { closeTs, tries: 3, lastTry: closeMs + SETTLE_GRACE_MS } },
      closeMs + SETTLE_GRACE_MS + 60_000,
    ).length === 0,
  );

  const many: PendingMap = {};
  for (let i = 0; i < 25; i++) many[`KX${i}`] = { closeTs: closeTs - i * 60, tries: 0, lastTry: 0 };
  const batch = duePending(many, closeMs + SETTLE_GRACE_MS + 1, 10);
  check("a backlog is drained a batch at a time", batch.length === 10);
  check("oldest close first, so the backlog drains in resolution order", batch[0] === "KX24");

  const pruned = prunePending(
    {
      tired: { closeTs, tries: MAX_TRIES, lastTry: 0 },
      ancient: { closeTs: Math.floor(closeMs / 1000) - 30 * 86_400, tries: 0, lastTry: 0 },
      fine: { closeTs, tries: 1, lastTry: 0 },
    },
    closeMs,
  );
  check("a market that will never answer is dropped", pruned.tired === undefined);
  check("so is one whose close was weeks ago", pruned.ancient === undefined);
  check("a live one is kept", pruned.fine !== undefined);

  // Round-trip through disk, since the map has to survive a restart.
  savePending({ KXA: { closeTs, tries: 2, lastTry: 7 } });
  check("the pending map survives a restart", loadPending().KXA?.tries === 2);

  appendSettlement({ ticker: "KXA", closeTs, result: "yes", ts: 1 });
  appendSettlement({ ticker: "KXB", closeTs, result: "no", ts: 2 });
  const rows = loadSettlements();
  check("outcomes round-trip", rows.length === 2 && rows[1].result === "no");
  check("the summary counts them", settlementInfo().settled === 2);

  fs.appendFileSync(path.join(dataDir(), "settlements.jsonl"), '{"ticker":"KXTORN","res', "utf-8");
  check(
    "a torn final line is skipped rather than fatal",
    loadSettlements().length === 2,
    `${loadSettlements().length}`,
  );

  clearSettlements();
  check("clearing removes both files", settlementInfo().settled === 0 && settlementInfo().pending === 0);
}

// ------------------------------------------------------- narration guardrails

section("a model may reword results, never invent them");
{
  const input = {
    subject: "a backtest",
    summary: "The best was Fee band at +$23.78 over 40 trades with 57% won; the worst was Default at -$129.80 over 155 trades.",
    evidence: [
      { label: "Fee band", value: "+$23.78 over 40 trades, 57% won, profit factor 1.34" },
      { label: "Default", value: "-$129.80 over 155 trades, 46% won, profit factor 0.62" },
    ],
  };

  check(
    "a faithful rewording passes",
    unsupportedNumbers(
      "Fee band finished ahead at +$23.78 across 40 trades, winning 57% of them, while Default lost $129.80 over 155 trades.",
      input,
    ).length === 0,
  );

  // The failure this exists for: a plausible, confident, fabricated P&L in the
  // app's own voice. Nothing else in the pipeline would catch it.
  check(
    "an invented total is caught",
    unsupportedNumbers("Fee band returned +$2,378 over the period.", input).includes("2378"),
  );
  check(
    "an invented win rate is caught",
    unsupportedNumbers("It won 71% of its trades.", input).includes("71"),
  );

  check(
    "counting words are allowed",
    unsupportedNumbers("Two of the 5 configurations finished ahead.", input).length === 0,
  );
  check(
    "rounding to the precision written is allowed",
    unsupportedNumbers("Fee band made about $23.8.", input).length === 0,
  );
  check(
    "prose with no numbers is fine",
    unsupportedNumbers("One configuration finished ahead and the rest lost money.", input).length === 0,
  );

  check("an OpenRouter key is recognised", looksLikeKey("sk-or-v1-0123456789abcdef0123456789abcdef"));
  check("a placeholder is refused", !looksLikeKey("your_key_here"));
  check("a truncated paste is refused", !looksLikeKey("sk-or-v1-short"));
  check("a quoted paste is refused", !looksLikeKey('"sk-or-v1-0123456789abcdef0123456789abcdef"'));
  check("every offered model is free", FREE_MODELS.every((m) => m.id.endsWith(":free")));
  check("the default model is one of them", FREE_MODELS.some((m) => m.id === DEFAULT_MODEL));

  // The vault must never hand the key back — the whole reason it lives in the
  // main process. aiStatus is the only reader the renderer gets.
  const statusKeys = Object.keys(aiStatus());
  check("the status summary exposes no key field", !statusKeys.includes("apiKey"), statusKeys.join(","));
}

// ------------------------------------------------------------------- the tape

section("recording what actually traded");
reset();
clearTape();
{
  const trade = (
    id: string,
    ticker: string,
    ts: number,
    price: number,
    takerSold: boolean,
    isBlock = false,
  ): KalshiTrade => ({ tradeId: id, ticker, ts, price, count: 5, takerSold, isBlock });

  const universe = new Set(["KXA", "KXB"]);
  const kept = keepTrades(
    [
      trade("1", "KXA", 1000, 85, true),
      trade("2", "KXZ", 1000, 85, true), // outside the recorded universe
      trade("3", "KXB", 1000, 85, false, true), // block trade
      trade("4", "KXB", 1000, 0, true), // no price
      trade("", "KXA", 1000, 85, true), // no id, cannot be deduplicated
    ],
    universe,
  );
  check("trades on unrecorded markets are dropped", !kept.some((t) => t.ticker === "KXZ"));
  // A block trade is negotiated off-book and never rested, so counting it
  // would credit a fill to an order that could not have been on the other side.
  check("block trades are dropped", !kept.some((t) => t.isBlock));
  check("priceless rows are dropped", !kept.some((t) => t.price === 0));
  check("rows with no id are dropped", !kept.some((t) => t.tradeId === ""));
  check("a real trade survives", kept.length === 1 && kept[0].tradeId === "1");

  check("nothing recorded means no tape", tapeInfo().exists === false);
  const n = recordTrades([trade("a", "KXA", 5_000, 85, true), trade("b", "KXA", 6_000, 84, false)]);
  check("trades are written", n === 2, `${n}`);
  check("the tape counts them", tapeInfo().trades === 2);

  // The poll window deliberately overlaps, so the same trade arrives twice.
  const again = recordTrades([trade("b", "KXA", 6_000, 84, false), trade("c", "KXA", 7_000, 83, true)]);
  check("a trade already written is not written again", again === 1, `${again}`);
  check("so the overlap does not inflate the file", tapeInfo().trades === 3);

  const tapeRows = loadTape();
  check("the tape round-trips", tapeRows.length === 3);
  check("the taker's direction survives", tapeRows[0].takerSold === true);
  check("...including when they were buying", tapeRows[1].takerSold === false);
  check("prices survive", tapeRows[2].price === 83);

  // Which is the whole reason the tape exists: a resting YES bid is filled by
  // somebody selling YES into it, not by somebody buying.
  const hits = tapeRows.filter((t) => t.takerSold && t.price <= 85);
  check("fills against a resting 85c bid are identifiable", hits.length === 2, `${hits.length}`);

  check("the watermark advances to the newest trade", loadTapeState().lastTs === 7_000);
  check(
    "the next poll reaches back past it so a slow cycle loses nothing",
    nextPollFrom() < 7_000 / 1000,
    `${nextPollFrom()}`,
  );

  fs.appendFileSync(path.join(dataDir(), "tape.jsonl"), '{"i":"torn","k":"KX', "utf-8");
  check("a torn final line is skipped", loadTape().length === 3, `${loadTape().length}`);
  check("...and the summary still reports the tape", tapeInfo().exists === true);

  clearTape();
  check("clearing removes the tape", tapeInfo().exists === false);
  check("...and its watermark, so a fresh run cold-starts", loadTapeState().lastTs === 0);

  // Rotation is a rename, so an archived file must still be readable and
  // countable. Simulated by writing the archive directly — provoking a real
  // 100MB rotation in a test would take a minute and a gigabyte.
  fs.writeFileSync(
    path.join(dataDir(), "tape.1.jsonl"),
    JSON.stringify({ i: "old1", k: "KXOLD", t: 1_000, p: 40, c: 3, s: 1 }) + "\n",
    "utf-8",
  );
  recordTrades([trade("new1", "KXNEW", 9_000, 88, false)]);
  const across = loadTape();
  check("the archived half of the tape is still read", across.length === 2, `${across.length}`);
  check("oldest first across the rotation", across[0].tradeId === "old1");
  check("the summary counts both files", tapeInfo().trades === 2);
  check("...and both their sizes", tapeInfo().bytes > 0);
  check("the span reaches back into the archive", tapeInfo().firstTs === 1_000);
  check("...and forward into the live file", tapeInfo().lastTs === 9_000);

  clearTape();
  check("clearing takes the archive too", loadTape().length === 0, `${loadTape().length}`);
}

section("backtest");
reset();
clearRecording();
{
  // A rise big enough to trigger entry, then a further rise to take profit.
  // Volume grows so the shipped defaults, gates included, replay as shipped.
  const scans: { ts: number; markets: Mkt[] }[] = [];
  const prices = [40, 40, 40, 40, 45, 46, 47, 48, 50, 52];
  prices.forEach((p, i) => {
    scans.push({
      ts: Date.now() + i * 15000,
      markets: [{ ...mkt("KXB", p, p + 1), volume: 100 + i * 20 }],
    });
  });

  const res = runBacktest(scans as never, { ...DEFAULT_SETTINGS, momentumThresholdCents: 3 }, "test");
  check("a replay produces trades", res.trades > 0, `${res.trades}`);
  check("the result is labelled", res.label === "test");
  check("wins and losses add up to trades", res.wins + res.losses <= res.trades);
  check("an equity curve is produced", res.equity.length === prices.length);
  check("exit reasons are counted", Object.keys(res.exitReasons).length > 0);

  // The whole point: the same data through different settings must differ.
  const tight = runBacktest(scans as never, { ...DEFAULT_SETTINGS, momentumThresholdCents: 40 }, "tight");
  check("an unreachable trigger trades nothing", tight.trades === 0, `${tight.trades}`);
  check("a no-trade run still reports cleanly", tight.pnlUsd === 0 && tight.winRate === null);

  // A replay must never be able to place an order, whatever it is handed.
  const live = runBacktest(scans as never, { ...DEFAULT_SETTINGS, liveMode: true }, "live-ish");
  check("live mode cannot leak into a replay", live.trades >= 0);

  // Replays must not touch the user's real history or equity.
  const historyBefore = loadHistory().length;
  runBacktest(scans as never, { ...DEFAULT_SETTINGS, requireConsistentMove: false }, "isolated");
  check("a replay leaves real history alone", loadHistory().length === historyBefore);

  // Determinism: the same input twice must give the same answer, or the
  // comparison the whole page is built on means nothing.
  const a = runBacktest(scans as never, { ...DEFAULT_SETTINGS, requireConsistentMove: false }, "a");
  const b = runBacktest(scans as never, { ...DEFAULT_SETTINGS, requireConsistentMove: false }, "b");
  check(
    "the same data and settings replay identically",
    a.trades === b.trades && a.pnlUsd === b.pnlUsd && a.wins === b.wins,
    `${a.trades}/${a.pnlUsd} vs ${b.trades}/${b.pnlUsd}`,
  );

  const all = compareStrategies(scans as never, { ...DEFAULT_SETTINGS, requireConsistentMove: false });
  check("comparison covers your settings plus every preset", all.length === STRATEGIES.length + 1);
  check("your settings come first", all[0].label === "Your settings");
  check("every preset is named", STRATEGIES.every((s) => all.some((r) => r.label === s.name)));
  check("drawdown is never negative", all.every((r) => r.maxDrawdownUsd >= 0));
}

section("parameter sweep");
reset();
{
  // Fifty scans of a wavy market with growing volume: enough movement that
  // some candidates trade on both sides of the split, nothing hand-tuned.
  const t0 = 1_700_000_000_000;
  const scans: { ts: number; markets: Mkt[] }[] = [];
  for (let i = 0; i < 50; i++) {
    const p = 45 + Math.round(6 * Math.sin(i / 3)) + (i % 9 === 4 ? 4 : 0);
    scans.push({
      ts: t0 + i * 15000,
      markets: [{ ...mkt("KXSW", p, p + 1), volume: 100 + i * 15 }],
    });
  }

  const report = runSweep(scans as never, { ...DEFAULT_SETTINGS, requireConsistentMove: false });
  check(
    "the split is 60/40 by time",
    report.scansTrain === 30 && report.scansTest === 20,
    `${report.scansTrain}/${report.scansTest}`,
  );
  check("the baseline is the user's settings", report.baseline?.label === "Current settings");
  check(
    "candidates are ranked by the held-out result",
    report.candidates.every(
      (c, i) => i === 0 || report.candidates[i - 1].testPnlUsd >= c.testPnlUsd,
    ),
  );
  check("the maker axis is searched", report.candidates.some((c) => c.label.includes("maker")));
  check("the best is the top of the ranking", report.bestOutOfSample === report.candidates[0]);
  check(
    "nothingWorked agrees with the best row",
    report.nothingWorked === ((report.bestOutOfSample?.testPnlUsd ?? 0) <= 0),
  );
  check("the fee floor is always in the notes", report.notes.some((n) => n.includes("Round-trip fee")));
  check(
    "every candidate has live mode forced off",
    report.candidates.every((c) => c.settings.liveMode === false),
  );

  // A flat training half and one clean run-up in the test half: whichever
  // candidate catches it "wins" on a couple of trades. The sweep must call
  // that luck out loud rather than crown it.
  const lucky: { ts: number; markets: Mkt[] }[] = [];
  for (let i = 0; i < 50; i++) {
    const p = i < 30 ? 45 : Math.min(78, 45 + (i - 29) * 2);
    lucky.push({
      ts: t0 + i * 15000,
      markets: [{ ...mkt("KXLK", p, p + 1), volume: 100 + i * 15 }],
    });
  }
  const luckyReport = runSweep(lucky as never, { ...DEFAULT_SETTINGS, requireConsistentMove: false });
  check(
    "a tiny-sample winner exists to test against",
    (luckyReport.bestOutOfSample?.testPnlUsd ?? 0) > 0 &&
      (luckyReport.bestOutOfSample?.testTrades ?? 99) < 10,
    `${luckyReport.bestOutOfSample?.testTrades} trades, $${luckyReport.bestOutOfSample?.testPnlUsd}`,
  );
  check(
    "the sweep calls a lucky winner noise",
    luckyReport.notes.some((n) => n.includes("treat it as noise")),
    luckyReport.notes.join(" | "),
  );
}

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

// ---------------------------------------------------------------- settlement & live orders

section("settlement bookkeeping");
reset();
{
  const posFor = (ticker: string) => ({
    ticker, title: "t", side: "yes" as const, entryCents: 40, contracts: 20,
    currentBidCents: 41, peakMidCents: 41, unrealizedUsd: 0, entryFeeUsd: 0.25,
    openedAt: Date.now(),
  });
  type Settleable = {
    status: string;
    cashUsd: number;
    positions: unknown[];
    settlePosition: (p: unknown, result: string) => void;
  };

  // YES settles at 100c: full payout, no exit fee — settlement is not a sale.
  let e = new TradingEngine({ ...DEFAULT_SETTINGS, requireConsistentMove: false });
  let anyE = e as unknown as Settleable;
  anyE.status = "running";
  anyE.cashUsd = 90;
  const winner = posFor("KXWIN");
  anyE.positions = [winner];
  anyE.settlePosition(winner, "yes");
  check("a yes settlement pays out at 100c", e.getState().cashUsd === 110, `${e.getState().cashUsd}`);
  check("the position is gone", e.getState().positions.length === 0);
  const settled = loadHistory().find((t) => t.ticker === "KXWIN");
  check("the trade is recorded as settled", settled?.reason === "settled yes");
  check("settlement pays no exit fee", settled?.pnlUsd === 11.75, `${settled?.pnlUsd}`);
  check("the exit price is the settlement", settled?.exitCents === 100);

  // NO settles at 0c: the position expires worthless.
  e = new TradingEngine({ ...DEFAULT_SETTINGS, requireConsistentMove: false });
  anyE = e as unknown as Settleable;
  anyE.status = "running";
  anyE.cashUsd = 90;
  const loser = posFor("KXLOSE");
  anyE.positions = [loser];
  anyE.settlePosition(loser, "no");
  check("a no settlement pays nothing", e.getState().cashUsd === 90);
  check("the loss is the whole entry plus its fee",
    loadHistory().find((t) => t.ticker === "KXLOSE")?.pnlUsd === -8.25);

  // A settlement without a yes/no result must wait, not guess.
  e = new TradingEngine({ ...DEFAULT_SETTINGS, requireConsistentMove: false });
  anyE = e as unknown as Settleable;
  anyE.status = "running";
  const odd = posFor("KXODD");
  anyE.positions = [odd];
  anyE.settlePosition(odd, "void");
  check("an unclear result leaves the position alone", e.getState().positions.length === 1);
  check("and books nothing", !loadHistory().some((t) => t.ticker === "KXODD"));
}

section("live resting orders are never abandoned");
reset();
{
  const liveCreds = { apiKeyId: "id", apiPrivateKeyPem: "pem" };
  const pending = (orderId: string | null) => ({
    ticker: "KXLIVE", title: "t", side: "yes" as const, limitCents: 40, contracts: 10,
    costUsd: 4, placedAt: Date.now(), ticksLeft: 3, orderId,
  });
  type OrderInternals = {
    client: { cancelOrder: (id: string) => Promise<void>; hasAuth: boolean };
    cashUsd: number;
    pendingOrders: unknown[];
    cancelPending: (o: unknown, why: string) => void;
    attachOrderId: (o: unknown, id: string) => void;
  };

  // cancelPending must kill the real order, not just the paper reservation —
  // this is the path stop() and flatten() go through.
  const cancelled: string[] = [];
  const e = new TradingEngine({ ...DEFAULT_SETTINGS, liveMode: true }, liveCreds);
  const anyE = e as unknown as OrderInternals;
  anyE.client = { cancelOrder: async (id) => void cancelled.push(id), hasAuth: true };
  anyE.cashUsd = 96;
  const o = pending("real-order-1");
  anyE.pendingOrders = [o];
  anyE.cancelPending(o, "test");
  check("cancelling locally cancels at the exchange", cancelled.includes("real-order-1"), cancelled.join(","));
  check("and the reservation is refunded", e.getState().cashUsd === 100);

  // The placement race: the exchange confirms an order we already dropped.
  const orphan = pending(null);
  anyE.attachOrderId(orphan, "late-arrival");
  check("a late order id for a dropped order is cancelled", cancelled.includes("late-arrival"));

  const tracked = pending(null);
  anyE.pendingOrders = [tracked];
  anyE.attachOrderId(tracked, "on-time");
  check("a late id for a live order is attached", (tracked as { orderId: string | null }).orderId === "on-time");
  check("— and not cancelled", !cancelled.includes("on-time"));
}

section("writes are atomic");
reset();
{
  saveSettings({ ...DEFAULT_SETTINGS, tradeSizeUsd: 21 });
  saveProfile("tmp-check", loadSettings());
  check("saves leave no .tmp files behind",
    fs.readdirSync(dataDir()).filter((f) => f.endsWith(".tmp")).length === 0);
  check("and the write still lands", loadSettings().tradeSizeUsd === 21);
}

section("sanitise fallbacks track the shipped defaults");
reset();
{
  // The hardcoded fallbacks drifted once: NaN take-profit fell back to the
  // pre-1.4.0 value of 6c, under the fee floor the defaults were moved past.
  saveSettings({ ...DEFAULT_SETTINGS, takeProfitCents: NaN, stopLossCents: NaN });
  const s = loadSettings();
  check("NaN take-profit falls back to the current default",
    s.takeProfitCents === DEFAULT_SETTINGS.takeProfitCents, `${s.takeProfitCents}`);
  check("NaN stop-loss falls back to the current default",
    s.stopLossCents === DEFAULT_SETTINGS.stopLossCents, `${s.stopLossCents}`);
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
recordScan([mkt("KXZ", 40, 41)]);
factoryReset();
check("reset deletes the scan recording", !fs.existsSync(path.join(dataDir(), "scans.jsonl")));

// ---------------------------------------------------------------- async tail
//
// refreshMissingMarkets awaits the Kalshi client, so its checks need an await
// of their own. Everything above runs synchronously first; the summary and
// exit live inside this closer so no result is printed before these land.

void (async () => {
  section("the settlement sweep");
  reset();
  clearSettlements();
  {
    const closeTs = 1_700_000_000;
    const now = closeTs * 1000 + SETTLE_GRACE_MS + 1;
    const asked: string[] = [];

    savePending({
      KXYES: { closeTs, tries: 0, lastTry: 0 },
      KXOPEN: { closeTs, tries: 0, lastTry: 0 },
      KXDEAD: { closeTs, tries: 0, lastTry: 0 },
    });

    const report = await sweepSettlements(async (ticker) => {
      asked.push(ticker);
      if (ticker === "KXYES") return { status: "settled", result: "yes" };
      if (ticker === "KXOPEN") return { status: "active", result: "" };
      throw new Error("404 gone");
    }, now);

    check("every due market was asked about", asked.length === 3, `${asked.length}`);
    check("the settled one was recorded", report.resolved === 1, `${report.resolved}`);
    check("the open one was counted, not recorded", report.stillOpen === 1);
    check("the failing one was counted too", report.failed === 1);

    const rows = loadSettlements();
    check("only the resolved market landed on disk", rows.length === 1 && rows[0].ticker === "KXYES");
    check("with the outcome Kalshi gave", rows[0].result === "yes");
    check("and the close time it was recorded against", rows[0].closeTs === closeTs);

    const after = loadPending();
    check("a resolved market stops being pending", after.KXYES === undefined);
    check("an open one stays, with its attempt counted", after.KXOPEN?.tries === 1);
    // A 404 and a 503 are handled identically on purpose: both count the
    // attempt, so a ticker that has genuinely vanished ages out instead of
    // being retried until the heat death of the universe.
    check("a failed lookup also counts its attempt", after.KXDEAD?.tries === 1);

    // Asking twice in a row must not double-count: the retry backoff holds
    // the market back until enough time has passed.
    const second = await sweepSettlements(async () => ({ status: "active", result: "" }), now + 1_000);
    check("backoff stops an immediate second attempt", second.asked === 0, `${second.asked}`);

    clearSettlements();
  }

  section("held markets are never blind");
  reset();
  {
    const posFor = (ticker: string) => ({
      ticker, title: "t", side: "yes" as const, entryCents: 40, contracts: 20,
      currentBidCents: 41, peakMidCents: 41, unrealizedUsd: 0, entryFeeUsd: 0.25,
      openedAt: Date.now(),
    });
    type RefreshInternals = {
      status: string;
      cashUsd: number;
      positions: unknown[];
      pendingOrders: unknown[];
      client: unknown;
      refreshMissingMarkets: (m: Mkt[]) => Promise<Mkt[]>;
    };
    const engineWithClient = (client: unknown): RefreshInternals => {
      const e = new TradingEngine({ ...DEFAULT_SETTINGS, requireConsistentMove: false }) as unknown as RefreshInternals;
      e.status = "running";
      e.client = client;
      return e;
    };

    // A held market missing from the sweep gets fetched and managed normally.
    let anyE = engineWithClient({
      getMarket: async (t: string) => ({ market: mkt(t, 44, 45), status: "open", result: "" }),
      hasAuth: false,
    });
    anyE.positions = [posFor("KXGONE")];
    const topped = await anyE.refreshMissingMarkets([mkt("KXOTHER", 50, 51)]);
    check("a held market missing from the sweep is fetched",
      topped.some((m) => m.ticker === "KXGONE" && m.yes_bid === 44));
    check("the sweep itself is untouched", topped.some((m) => m.ticker === "KXOTHER"));

    // A ticker still in the sweep is not fetched twice.
    let fetches = 0;
    anyE = engineWithClient({
      getMarket: async (t: string) => (fetches++, { market: mkt(t, 44, 45), status: "open", result: "" }),
      hasAuth: false,
    });
    anyE.positions = [posFor("KXHERE")];
    await anyE.refreshMissingMarkets([mkt("KXHERE", 40, 41)]);
    check("a market still in the sweep is not re-fetched", fetches === 0, `${fetches}`);

    // Settlement arriving through the refresh books the position and frees
    // any resting order on the same market.
    anyE = engineWithClient({
      getMarket: async () => ({ market: mkt("KXDONE", 0, 0), status: "settled", result: "yes" }),
      hasAuth: false,
    });
    anyE.cashUsd = 90;
    anyE.positions = [posFor("KXDONE")];
    anyE.pendingOrders = [{
      ticker: "KXDONE", title: "t", side: "yes", limitCents: 40, contracts: 5,
      costUsd: 2, placedAt: Date.now(), ticksLeft: 3, orderId: null,
    }];
    await anyE.refreshMissingMarkets([]);
    check("a settlement found by the refresh is booked",
      loadHistory().some((t) => t.ticker === "KXDONE" && t.reason === "settled yes"));
    check("its resting order is released too", anyE.pendingOrders.length === 0);
    check("payout and refund both reach cash", Math.round(anyE.cashUsd * 100) / 100 === 112, `${anyE.cashUsd}`);

    // A failed fetch must not fail the tick — the position just waits.
    anyE = engineWithClient({
      getMarket: async () => {
        throw new Error("api down");
      },
      hasAuth: false,
    });
    anyE.positions = [posFor("KXDOWN")];
    const survived = await anyE.refreshMissingMarkets([]);
    check("a failed refresh leaves the position for next scan",
      anyE.positions.length === 1 && survived.length === 0);

    // A one-sided book must not reach the exits: the sweep filters those
    // out, so a missing bid handed through here would read as bid 0 and
    // "stop-loss" the position at a total loss that never happened.
    anyE = engineWithClient({
      getMarket: async (t: string) => ({ market: mkt(t, 0, 45), status: "open", result: "" }),
      hasAuth: false,
    });
    anyE.positions = [posFor("KXTHIN")];
    const oneSided = await anyE.refreshMissingMarkets([]);
    check("a book with no bids is held, not stopped out",
      oneSided.length === 0 && anyE.positions.length === 1);
  }

  section("live orders drain before quit");
  reset();
  {
    const liveCreds = { apiKeyId: "id", apiPrivateKeyPem: "pem" };
    type DrainInternals = {
      status: string;
      cashUsd: number;
      positions: unknown[];
      pendingOrders: unknown[];
      client: unknown;
      closePosition: (p: unknown, reason: string) => void;
      cancelPending: (o: unknown, why: string) => void;
    };

    // A closing sell that resolves after stop() must still land before drain
    // returns — that is the whole point of draining.
    let sellLanded = false;
    const e = new TradingEngine({ ...DEFAULT_SETTINGS, liveMode: true }, liveCreds);
    const anyE = e as unknown as DrainInternals;
    anyE.status = "running";
    anyE.client = {
      hasAuth: true,
      placeOrder: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            sellLanded = true;
            resolve({});
          }, 40),
        ),
      cancelOrder: () => new Promise(() => {}), // never resolves
    };
    anyE.cashUsd = 100;
    const pos = {
      ticker: "KXQUIT", title: "t", side: "yes", entryCents: 40, contracts: 10,
      currentBidCents: 41, peakMidCents: 41, unrealizedUsd: 0, entryFeeUsd: 0.1,
      openedAt: Date.now(),
    };
    anyE.positions = [pos];
    anyE.closePosition(pos, "engine stopped");
    check("the sell is in flight, not yet landed", sellLanded === false);
    await e.drainLiveOrders(2000);
    check("draining waits for the closing sell", sellLanded === true);

    // A dead network must not hold the quit hostage: the never-resolving
    // cancel above is bounded by the timeout.
    const order = {
      ticker: "KXHANG", title: "t", side: "yes", limitCents: 40, contracts: 5,
      costUsd: 2, placedAt: Date.now(), ticksLeft: 3, orderId: "hung-order",
    };
    anyE.pendingOrders = [order];
    anyE.cancelPending(order, "quit test");
    const t0 = Date.now();
    await e.drainLiveOrders(80);
    const waited = Date.now() - t0;
    check("a hung order cannot hold the quit hostage", waited < 1500, `${waited}ms`);

    // Nothing in flight resolves immediately — dry-run quits pay no toll.
    const idle = new TradingEngine({ ...DEFAULT_SETTINGS, requireConsistentMove: false });
    const t1 = Date.now();
    await idle.drainLiveOrders(4000);
    check("an idle engine drains instantly", Date.now() - t1 < 100);
  }

  section("live take-profit plumbing");
  reset();
  {
    const liveCreds = { apiKeyId: "id", apiPrivateKeyPem: "pem" };
    const placed: string[] = [];
    const cancelled: string[] = [];
    type TpInternals = {
      status: string;
      cashUsd: number;
      client: unknown;
      positions: unknown[];
      restTakeProfit: (p: unknown) => void;
      attachTpOrderId: (p: unknown, id: string) => void;
      closePosition: (p: unknown, reason: string) => void;
    };
    const live = new TradingEngine(
      { ...DEFAULT_SETTINGS, liveMode: true, makerExits: true },
      liveCreds,
    ) as unknown as TpInternals;
    live.status = "running";
    live.cashUsd = 100;
    live.client = {
      hasAuth: true,
      placeLimitSell: async (t: string) => (placed.push(t), "tp-order-1"),
      placeOrder: async () => ({}),
      cancelOrder: async (id: string) => void cancelled.push(id),
    };
    const livePos = {
      ticker: "KXLTP", title: "t", side: "yes", entryCents: 40, contracts: 10,
      currentBidCents: 41, peakMidCents: 41, unrealizedUsd: 0, entryFeeUsd: 0.1,
      tpRestingCents: null as number | null, tpOrderId: null as string | null,
      openedAt: Date.now(),
    };
    live.positions = [livePos];
    live.restTakeProfit(livePos);
    await new Promise((r) => setTimeout(r, 10)); // let the stubbed placement land
    check("live mode places the resting sell", placed.includes("KXLTP"));
    check("the order id is attached", livePos.tpOrderId === "tp-order-1");
    live.closePosition(livePos, "stop-loss");
    check("a stop cancels the resting sell at the exchange", cancelled.includes("tp-order-1"));

    // The race guard: an id arriving for a gone position is cancelled.
    const gone = { ...livePos, ticker: "KXGONE2", tpOrderId: null };
    live.positions = [];
    live.attachTpOrderId(gone, "late-tp");
    check("a late take-profit id for a gone position is cancelled", cancelled.includes("late-tp"));
  }

  section("a refused entry never becomes a position");
  reset();
  {
    const liveCreds = { apiKeyId: "id", apiPrivateKeyPem: "pem" };
    type EntryInternals = {
      status: string;
      cashUsd: number;
      client: unknown;
      positions: { ticker: string; tpOrderId: string | null }[];
      openPosition: (m: unknown) => void;
    };
    const market = {
      ticker: "KXREFUSE", title: "refused market", yes_bid: 40, yes_ask: 42,
      last_price: 41, volume: 500, volume_24h: 900, status: "active",
      close_ts: Math.floor(Date.now() / 1000) + 7200,
    };

    const e = new TradingEngine(
      { ...DEFAULT_SETTINGS, liveMode: true, tradeSizeUsd: 10 },
      liveCreds,
    ) as unknown as EntryInternals;
    e.status = "running";
    e.cashUsd = 100;
    const cancelled: string[] = [];
    e.client = {
      hasAuth: true,
      placeOrder: async () => {
        throw new Error("insufficient funds");
      },
      cancelOrder: async (id: string) => void cancelled.push(id),
    };

    e.openPosition(market);
    check("the position is held while the order is in flight", e.positions.length === 1);
    const cashWhileOpen = e.cashUsd;
    check("its cost is debited immediately", cashWhileOpen < 100);

    await new Promise((r) => setTimeout(r, 10)); // let the rejection land
    check("a refused buy leaves no position behind", e.positions.length === 0);
    check("the money comes back", Math.abs(e.cashUsd - 100) < 0.001, `cash ${e.cashUsd}`);

    // With maker exits on, a take-profit is rested the instant the position
    // opens — it must not outlive an entry that was refused.
    const withTp = new TradingEngine(
      { ...DEFAULT_SETTINGS, liveMode: true, tradeSizeUsd: 10, makerExits: true },
      liveCreds,
    ) as unknown as EntryInternals;
    withTp.status = "running";
    withTp.cashUsd = 100;
    const tpCancelled: string[] = [];
    withTp.client = {
      hasAuth: true,
      // Slower than the take-profit below, so the id is attached before the
      // rejection arrives — the case where a stray order can actually be left.
      placeOrder: () =>
        new Promise((_r, reject) => setTimeout(() => reject(new Error("market closed")), 20)),
      placeLimitSell: async () => "tp-orphan",
      cancelOrder: async (id: string) => void tpCancelled.push(id),
    };
    withTp.openPosition({ ...market, ticker: "KXORPHAN" });
    await new Promise((r) => setTimeout(r, 60));
    check("the refused entry took its take-profit with it", tpCancelled.includes("tp-orphan"));
    check("and left no position", withTp.positions.length === 0);
    check("a voided entry is not recorded as a trade", loadHistory().length === 0);
  }

  section("an exit is booked only once the sell is accepted");
  reset();
  {
    const liveCreds = { apiKeyId: "id", apiPrivateKeyPem: "pem" };
    type ExitInternals = {
      status: string;
      cashUsd: number;
      client: unknown;
      positions: unknown[];
      haltedReason: string | null;
      closePosition: (p: unknown, reason: string) => void;
    };
    const freshPos = (ticker: string) => ({
      ticker, title: "t", side: "yes", entryCents: 40, contracts: 10,
      currentBidCents: 41, peakMidCents: 41, unrealizedUsd: 0, entryFeeUsd: 0.1,
      tpRestingCents: null as number | null, tpOrderId: null as string | null,
      openedAt: Date.now(),
    });

    // 1. A sell that fails leaves the position exactly where it was.
    const failing = new TradingEngine(
      { ...DEFAULT_SETTINGS, liveMode: true },
      liveCreds,
    ) as unknown as ExitInternals;
    failing.status = "running";
    failing.cashUsd = 100;
    const sentIds: (string | undefined)[] = [];
    failing.client = {
      hasAuth: true,
      placeOrder: async (p: { clientOrderId?: string }) => {
        sentIds.push(p.clientOrderId);
        throw new Error("network down");
      },
      cancelOrder: async () => {},
    };
    const stuck = freshPos("KXSTUCK");
    failing.positions = [stuck];
    failing.closePosition(stuck, "stop-loss");
    await new Promise((r) => setTimeout(r, 10));
    check("a failed sell keeps the position open", failing.positions.length === 1);
    check("and books nothing to history", loadHistory().length === 0);
    check("the cash is not credited for a sale that did not happen", failing.cashUsd === 100);

    // 2. The retry is the same order, not another one.
    failing.closePosition(stuck, "stop-loss");
    await new Promise((r) => setTimeout(r, 10));
    check("the exit is retried on the next scan", sentIds.length === 2);
    check(
      "the retry reuses one client_order_id, so it cannot double-sell",
      sentIds[0] !== undefined && sentIds[0] === sentIds[1],
      `${sentIds[0]} vs ${sentIds[1]}`,
    );

    // 3. The third failure gives up: halt, and the position stays put.
    failing.closePosition(stuck, "stop-loss");
    await new Promise((r) => setTimeout(r, 10));
    check("it stops trying after three attempts", sentIds.length === 3);
    check("the engine halts itself", failing.haltedReason !== null);
    check(
      "the halt names the position still open at Kalshi",
      (failing.haltedReason ?? "").includes("KXSTUCK"),
    );
    check("which is still in the ledger, not silently closed", failing.positions.length === 1);
    check("and still absent from history", loadHistory().length === 0);
    failing.closePosition(stuck, "stop-loss");
    await new Promise((r) => setTimeout(r, 10));
    check("a fourth attempt is refused", sentIds.length === 3);

    // 4. A 409 means Kalshi already has this order — the first attempt landed.
    reset();
    const dup = new TradingEngine(
      { ...DEFAULT_SETTINGS, liveMode: true },
      liveCreds,
    ) as unknown as ExitInternals;
    dup.status = "running";
    dup.cashUsd = 100;
    let dupAttempts = 0;
    dup.client = {
      hasAuth: true,
      placeOrder: async () => {
        dupAttempts++;
        if (dupAttempts === 1) throw new Error("connection reset");
        throw new KalshiApiError("Kalshi POST /portfolio/orders -> 409: duplicate", 409);
      },
      cancelOrder: async () => {},
    };
    const raced = freshPos("KXDUP");
    dup.positions = [raced];
    dup.closePosition(raced, "stop-loss");
    await new Promise((r) => setTimeout(r, 10));
    check("the lost answer leaves the position open", dup.positions.length === 1);
    dup.closePosition(raced, "stop-loss");
    await new Promise((r) => setTimeout(r, 10));
    check("a duplicate rejection is read as the original having filled", dup.positions.length === 0);
    check("so the exit is booked once", loadHistory().length === 1);
    check("the engine does not halt over it", dup.haltedReason === null);

    // 5. The ordinary case still works.
    reset();
    const ok = new TradingEngine(
      { ...DEFAULT_SETTINGS, liveMode: true },
      liveCreds,
    ) as unknown as ExitInternals;
    ok.status = "running";
    ok.cashUsd = 100;
    ok.client = { hasAuth: true, placeOrder: async () => ({}), cancelOrder: async () => {} };
    const good = freshPos("KXFINE");
    ok.positions = [good];
    ok.closePosition(good, "take-profit");
    await new Promise((r) => setTimeout(r, 10));
    check("an accepted sell closes the position", ok.positions.length === 0);
    check("and records the trade", loadHistory().length === 1);
    check("crediting the proceeds", ok.cashUsd > 100, `cash ${ok.cashUsd}`);
  }

  // ------------------------------------------------- api client resilience

  {
    section("the API client cannot hang forever");

    const realFetch = globalThis.fetch;
    let calls = 0;

    // A socket that connects and then goes quiet. Only the abort signal ends it.
    // Count only the URL under test: an engine started in an earlier section
    // keeps ticking through the stubbed global fetch during the retry sleeps,
    // and its traffic would otherwise be counted as retries of this request.
    const hang: typeof globalThis.fetch = (url, init) =>
      new Promise((_resolve, reject) => {
        if (String(url).includes("KXHANG")) calls++;
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "TimeoutError";
          reject(e);
        });
      });

    try {
      globalThis.fetch = hang;
      // 40ms timeout: the same code path as production, without the wait.
      const client = new KalshiClient("", "", 40);
      const began = Date.now();
      let threw = "";
      try {
        await client.getMarket("KXHANG");
      } catch (e) {
        threw = (e as Error).message;
      }
      const elapsed = Date.now() - began;

      check("a hung request rejects instead of pending forever", threw !== "");
      check("the rejection names the timeout", threw.includes("timed out"));
      check("it gives up promptly", elapsed < 2000);
      check(`a read is retried before giving up (3 attempts, saw ${calls})`, calls === 3);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  {
    section("reads retry, writes never do");

    const realFetch = globalThis.fetch;
    const seen: string[] = [];

    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    try {
      // A read that is rate-limited once, then succeeds.
      let readHits = 0;
      globalThis.fetch = (async (_u, init) => {
        seen.push(String(init?.method ?? "GET"));
        readHits++;
        if (readHits === 1) return json({ error: "slow down" }, 429);
        return json({ market: { ticker: "KXOK", title: "ok", status: "open" } });
      }) as typeof globalThis.fetch;

      const reader = new KalshiClient("", "", 500);
      const got = await reader.getMarket("KXOK");
      check("a 429'd read is retried and then succeeds", got.market.ticker === "KXOK");
      check("the retry actually re-requested", readHits === 2);

      // A write that fails with a server error is NOT retried: a timed-out
      // order may already be live at the exchange, so repeating it risks a
      // second position.
      seen.length = 0;
      let writeHits = 0;
      globalThis.fetch = (async (_u, init) => {
        seen.push(String(init?.method ?? "GET"));
        writeHits++;
        return json({ error: "server fell over" }, 500);
      }) as typeof globalThis.fetch;

      // A real key: signing with an empty PEM throws before any request is
      // made, which would measure the crypto failure rather than the retry rule.
      const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const writer = new KalshiClient("kid", pem, 500);
      let writeThrew = false;
      try {
        await writer.cancelOrder("order-1");
      } catch {
        writeThrew = true;
      }
      check("a failing write surfaces the error", writeThrew);
      check(`a write is attempted exactly once (saw ${writeHits})`, writeHits === 1);
      check("no retry was issued for the write", seen.length === 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // ---------------------------------------------------------------- result

  console.log(`\n${"=".repeat(52)}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
})();
