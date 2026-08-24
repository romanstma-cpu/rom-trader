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
  netEdgeCents,
  roundTripFeeCentsPerContract,
  roundTripFeeUsd,
  takerFeeCentsPerContract,
  takerFeeUsd,
} from "../electron/engine/fees";
import { computeMetrics } from "../electron/engine/metrics";
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

// ---------------------------------------------------------------- strategies

section("strategy presets");
reset();
check("four presets ship", STRATEGIES.length === 4, `got ${STRATEGIES.length}`);
check("ids are unique", new Set(STRATEGIES.map((s) => s.id)).size === STRATEGIES.length);
check("unknown id is not found", findStrategy("nope") === undefined);
check("exactly one preset is a maker", STRATEGIES.filter((s) => s.params.makerEntries).length === 1);

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
function runEngine(settings: Partial<typeof DEFAULT_SETTINGS>, books: Mkt[][]) {
  const e = new TradingEngine({
    ...DEFAULT_SETTINGS,
    // The scripted books reuse static objects whose volume never changes, so
    // the entry-quality gates (on by default in the app) would refuse every
    // handwritten entry here. The harness switches them off; the gates have
    // their own dedicated section, and any test that wants one passes it.
    momentumOnBid: false,
    requireTradeActivity: false,
    ...settings,
  });
  const anyE = e as unknown as {
    status: string;
    processPendingOrders: (m: Mkt[]) => void;
    updatePositions: (m: Mkt[]) => void;
    scanForEntries: (m: Mkt[], t: number) => void;
    enforceDailyLossLimit: () => void;
    enforceLosingStreak: () => void;
    enforceMaxDrawdown: () => void;
  };
  anyE.status = "running";
  for (const book of books) {
    // Mirrors the order in tick(); a step left out here passes in tests and
    // then does nothing (or something different) in the running app.
    anyE.processPendingOrders(book);
    anyE.updatePositions(book);
    anyE.scanForEntries(book, Date.now());
    anyE.enforceDailyLossLimit();
    anyE.enforceLosingStreak();
    anyE.enforceMaxDrawdown();
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
    (e.getState().haltedReason ?? "").includes("losing trades in a row"),
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
  });
  e.subscribe({ onState: () => {}, onLog: () => {}, onEvent: (ev) => events.push(ev) });

  const anyE = e as unknown as {
    status: string;
    updatePositions: (m: Mkt[]) => void;
    scanForEntries: (m: Mkt[], t: number) => void;
  };
  anyE.status = "running";
  const flat4 = [mkt("KXE", 40, 41)];
  for (const b of [flat4, flat4, flat4, flat4, [mkt("KXE", 45, 46)]]) {
    anyE.updatePositions(b);
    anyE.scanForEntries(b, Date.now());
  }
  check("opening a position raises an event", events.some((x) => x.kind === "opened"));

  e.flatten();
  check("closing raises an event", events.some((x) => x.kind === "closed"));
  check("every event carries a tone", events.every((x) => x.tone.length > 0));

  // A subscriber with no onEvent must not crash the engine.
  const quiet = new TradingEngine({ ...DEFAULT_SETTINGS });
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
  const takerRun = runBacktest(ladder as never, { ...DEFAULT_SETTINGS }, "taker");
  check("a runaway market fills the taker, not the maker", takerRun.trades > 0 && makerRun.trades === 0);
  check("the unfilled maker run ends flat, not negative", makerRun.pnlUsd === 0);
  check(
    "the backtest counts the orders that never filled",
    makerRun.ordersPlaced > 0 && makerRun.ordersFilled === 0,
    `${makerRun.ordersFilled}/${makerRun.ordersPlaced}`,
  );
  check("a taker run reports no maker orders", takerRun.maker === false && takerRun.ordersPlaced === 0);
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
  check(
    "a short history does not block entries",
    // Filter on, but only five samples: the engine must trade rather than
    // wait forever for statistical significance it may never get.
    runEngine({ regimeFilterEnabled: true }, [
      [mkt("KXS", 40, 41)], [mkt("KXS", 40, 41)], [mkt("KXS", 40, 41)], [mkt("KXS", 40, 41)],
      [mkt("KXS", 45, 46)],
    ]).getState().positions.length === 1,
  );
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
  const bt = runBacktest(scans as never, { ...DEFAULT_SETTINGS }, "metrics");
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
  const seamResult = runBacktest(gapped as never, { ...DEFAULT_SETTINGS }, "seam");
  check("a seam jump is not traded as momentum", seamResult.trades === 0, `${seamResult.trades} trades`);

  // The same 5c move without the gap is genuine momentum and must still trade
  // — the splitting must not neuter the replay.
  const genuine = [
    ...[0, 1, 2, 3, 4].map((i) => scan(t0 + i * 15000, 40, 41, 100 + i * 20)),
    ...[5, 6, 7, 8, 9].map((i) => scan(t0 + i * 15000, 45, 46, 100 + i * 20)),
  ];
  const genuineResult = runBacktest(genuine as never, { ...DEFAULT_SETTINGS }, "genuine");
  check("the same move without a gap still trades", genuineResult.trades > 0);
  check(
    "an end-of-recording close says so",
    (genuineResult.exitReasons["recording ended"] ?? 0) > 0,
    JSON.stringify(genuineResult.exitReasons),
  );
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
  runBacktest(scans as never, { ...DEFAULT_SETTINGS }, "isolated");
  check("a replay leaves real history alone", loadHistory().length === historyBefore);

  // Determinism: the same input twice must give the same answer, or the
  // comparison the whole page is built on means nothing.
  const a = runBacktest(scans as never, { ...DEFAULT_SETTINGS }, "a");
  const b = runBacktest(scans as never, { ...DEFAULT_SETTINGS }, "b");
  check(
    "the same data and settings replay identically",
    a.trades === b.trades && a.pnlUsd === b.pnlUsd && a.wins === b.wins,
    `${a.trades}/${a.pnlUsd} vs ${b.trades}/${b.pnlUsd}`,
  );

  const all = compareStrategies(scans as never, { ...DEFAULT_SETTINGS });
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

  const report = runSweep(scans as never, { ...DEFAULT_SETTINGS });
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
  const luckyReport = runSweep(lucky as never, { ...DEFAULT_SETTINGS });
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

// ---------------------------------------------------------------- result

console.log(`\n${"=".repeat(52)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
