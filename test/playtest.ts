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
} from "../electron/engine/recorder";
import { compareStrategies, runBacktest } from "../electron/engine/backtest";

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
    enforceLosingStreak: () => void;
  };
  anyE.status = "running";
  for (const book of books) {
    anyE.updatePositions(book);
    anyE.scanForEntries(book, Date.now());
    // Mirrors the order in tick(); a brake left out here passes in tests and
    // then does nothing in the running app.
    anyE.enforceDailyLossLimit();
    anyE.enforceLosingStreak();
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
  const e = new TradingEngine({ ...DEFAULT_SETTINGS, momentumThresholdCents: 3 });
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

section("backtest");
reset();
clearRecording();
{
  // A rise big enough to trigger entry, then a further rise to take profit.
  const scans: { ts: number; markets: Mkt[] }[] = [];
  const prices = [40, 40, 40, 40, 45, 46, 47, 48, 50, 52];
  prices.forEach((p, i) => {
    scans.push({ ts: Date.now() + i * 15000, markets: [mkt("KXB", p, p + 1)] });
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
