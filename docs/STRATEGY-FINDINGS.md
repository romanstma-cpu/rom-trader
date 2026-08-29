# What the simulations found

Run them yourself: `npm run simulate`.

Ten independent synthetic markets per configuration, 600 scans each, under three
regimes — a random walk with no edge to find, a momentum market, and a
mean-reverting one. Synthetic markets are used because replaying one real
recording cannot separate "this setting works" from "that afternoon suited it".

## Three bugs, found by the numbers not making sense

### 1. Fees were not modelled at all

The engine buys at the ask and sells at the bid, so it is a **taker on both
sides** and pays Kalshi's taker fee twice per round trip:

```
fee = ceil_to_cent(0.07 × contracts × P × (1 − P))
```

That is **3.5c per contract** round trip near 50c. Against the shipped 6c
take-profit it ate more than half of every win, and against the 4c stop it
nearly doubled every loss. Paper trading reported gross numbers, so dry-run
results were systematically optimistic about the thing users judge it on.

Now charged on entry and exit, and reflected in unrealised P&L — a position
shows what it would actually net if closed now.

### 2. The stop-loss barely did anything

Two tables returned byte-identical results for different stop-losses. That is
not a coincidence, and chasing it found the cause: the third exit reused
`momentumThresholdCents` — the **entry** trigger — as a trailing stop. At its
3c default it fired on any small pullback, before the stop-loss or the
take-profit could apply.

The Settings page presented "Stop loss" as a primary risk control while it was
effectively dead for any value above about 5c.

It now has its own setting, `trailingStopCents`, defaulting to **off**.

### 3. The spread is charged twice and the settings ignored it

Entry at the ask and exit at the bid means a position opens at `-spread`. So
the price must move `takeProfit + spread` to win, but only `stopLoss − spread`
to lose. With the shipped tp6 / sl4 and a 2c spread:

| | move needed |
|---|---|
| to hit take-profit | **+8c** |
| to hit stop-loss | **−2c** |

A 4:1 adverse ratio before a penny of fees. A stop at or under the spread is
stopped out on entry.

## What the measurements say

With the trailing exit given its own control, both it and the stop respond for
the first time (momentum market, tp12):

| trailing exit | trades | win | avg P&L |
|---|---|---|---|
| off | 69 | 41% | −$39.57 |
| 3c (the old behaviour) | 267 | 20% | −$233.76 |
| 6c | 147 | 24% | −$129.08 |
| 15c | 75 | 37% | −$51.34 |

| stop-loss | trades | win | avg P&L |
|---|---|---|---|
| 4c | 169 | 20% | −$161.13 |
| 12c | 57 | 43% | −$35.09 |
| 20c | 34 | 51% | −$26.11 |

## The honest conclusion

**Every configuration lost money, in every regime, including one built to have
exactly the momentum this strategy looks for.**

Most of the apparent improvement above is just trading less. Fewer trades means
fewer fees, which approaches breaking even by approaching doing nothing. The
random-walk control loses about as much per trade as the momentum market does,
which is the clearest statement available that the rule is not extracting much
signal.

The arithmetic is unforgiving. A $10 position at 50c is 20 contracts, costing
about $0.70 to open and close — **7% of the position**. A 3c signal on a 50c
contract is a 6% move. The cost is larger than the edge being chased.

## What would actually change the outcome

1. **Stop being a taker.** Kalshi makers — resting limit orders — pay close to
   nothing. This removes almost the entire cost, and it is the only change here
   that alters the sign rather than the size of the result. It needs real limit
   order support and handling for fills that never arrive.
2. **Trade away from 50c.** The fee curve is parabolic: 3.5c round trip at 50c
   against 2.2c at 20c or 80c. Roughly a third cheaper.
3. **Demand a bigger move.** The entry trigger should be required to exceed
   fee plus spread by a real margin, not by a cent.
4. **Trade less.** Every table above improves mainly by doing so.

None of that is a promise of profit. A momentum heuristic on a public order
book is not a demonstrated edge, and the app says so.

## Caveat

These are synthetic markets with chosen properties, not Kalshi. They are good
for finding structural problems — an exit that swallows every trade, a cost
that exceeds the edge — because those show up regardless of the data. They
cannot tell you what real Kalshi markets do. Recording real sweeps and
replaying them on the Backtest page is what does that, and 1.4.0 records every
sweep for exactly this reason.

---

# 1.5.0: the recommendations, built and measured

1.4.0 ended with four recommendations. 1.5.0 implements them and reports what
the same ten-seed, three-regime harness measured. The engine also now computes
real performance metrics — profit factor, expectancy, per-trade Sharpe and
Sortino, streaks, drawdown percent — on every backtest, because "made $3"
hides whether that was forty coin flips or four clean trades.

## Maker entries: measured, and humbler than hoped

The prediction was that resting at the bid — no entry fee, no spread paid —
was "the only change that alters the sign rather than the size." Built, with a
deliberately conservative fill model: a resting buy at L fills only when the
ask trades down to L, because queue position at Kalshi is unknowable from here
and an optimistic fill model is how a backtest lies.

| regime | taker avg P&L | maker avg P&L | taker PF | maker PF |
|---|---|---|---|---|
| random | −$36.13 | −$30.25 | 0.41 | 0.47 |
| momentum | −$35.09 | −$33.17 | 0.65 | 0.63 |
| revert | −$24.03 | −$18.36 | 0.36 | 0.43 |

**The sign did not flip.** The fee and spread savings are real — roughly 5.5c
per round trip down to 1.75c — but the conservative fill model shows where
most of it goes: **adverse selection**. A resting bid fills precisely when the
market trades down through it, which is the moment the momentum that justified
the order is being contradicted. The maker buys the dips of its own signal.

The full "Patient" combination (maker entries, 4c trigger, 3c edge margin,
regime filter, 6-scan TTL) cuts the bleed roughly in half across every regime
— −$18 / −$23 / −$8 against −$36 / −$35 / −$24 — without turning any of them
positive. Trading less and paying less per trade, which is improvement of
size, not of sign.

## The first positive row this project ever produced, and why it does not count

Table 14 raises the minimum-net-edge margin past the mid-price fee, which
confines entries to the cheap ends of the fee curve (under ~17c, over ~83c):

| config (tp8, momentum) | trades | win | PF | avg P&L |
|---|---|---|---|---|
| min net edge 0c | 78 | 49% | 0.47 | −$69.42 |
| min net edge 6c | 26 | 52% | **1.58** | **+$17.57** |
| min net edge 6c · **random control** | 10 | 57% | **1.50** | **+$5.21** |

The third row is the verdict. A random walk cannot be beaten; a configuration
that profits there is exploiting the simulator, not the market. The suspect is
identified: the synthetic price reflects off its 5c/95c boundaries so prices
do not pile up and go quiet, and reflection is deterministic mean-reversion
exactly where this filter trades. Buying near the floor with a wall that
bounces prices upward is a rigged game the real market does not offer.

So the one profitable configuration found in two versions of this research is
an artifact, caught by the control built to catch it. It is left in the output
as a worked example of why table 4 and 8 are read first.

## The regime filter: small, and only in combination

Skipping markets whose recent moves have negative lag-1 autocorrelation did
almost nothing on its own (table 13 — within noise everywhere, slightly worse
in the regime it was built for). Inside the Patient configuration it earns a
modest keep, mostly in the mean-reverting world (−$7.66 with it, −$19.47
without), and mostly by trading less there: 6 entries instead of 19. It ships
**off by default**; it is on in the Patient preset because refusing trades in
a hostile regime is the one thing it demonstrably does.

## Risk controls added

- **Drawdown brake**: the engine halts once session equity falls a set percent
  below its session peak (default 20%), and trade size scales linearly down to
  a quarter as drawdown approaches the line. Kelly sizing was considered and
  rejected: it needs a trusted edge estimate, estimating one from a rolling
  handful of trades produces size swings that are noise wearing a suit, and
  with no demonstrated positive edge Kelly's honest answer is zero — which is
  what the halt line is for.
- **Edge margin** (`minNetEdgeCents`, default 2c): entries must clear the fees
  by a real margin, not by half a cent.
- The parameter sweep gained the maker/taker axis, and every backtest now
  reports profit factor, expectancy and per-trade Sharpe alongside P&L.

## The honest conclusion, updated

Every recommendation from 1.4.0 is now implemented and measured. Together they
roughly halve the losses in every synthetic regime. **None of them makes any
regime profitable**, and the one row that claimed to was disqualified by its
own control. The app's disclaimer stands unchanged: this is a momentum
heuristic on a public order book, with no demonstrated forward edge. What
changed in 1.5.0 is that the bot loses slower, refuses more bad trades,
measures itself honestly, and can now be tested as a maker against real
recorded Kalshi data — which is the experiment that actually matters, and the
one these synthetic worlds cannot run.

---

# 1.6.0: the first real recordings, and what the mid was hiding

No recording existed — the engine had never been left running since recording
shipped. So 1.6.0 adds `scripts/record.ts`, a headless recorder that polls the
same public endpoint at the same cadence and writes the app's own
`scans.jsonl`, and `scripts/replay.ts`, which replays it through the real
engine and reports the order counts maker mode lives or dies by. Recordings
with stop/restart seams are split into contiguous segments first: a seam
replayed naively moves prices an hour in one step and manufactures momentum
no live engine ever saw.

## What real books look like

Roughly 43 minutes of a Sunday night, 220 distinct markets: **median spread
7c**, with only **11% of books inside the default 2c spread limit**. The
synthetic worlds ran a constant 2c spread. Real overnight Kalshi is far
coarser, and that coarseness is what exposed the defect below.

## The defect: mid-price momentum is half quote noise

The momentum signal was measured on the mid. The mid rises by half of any
one-sided quote change — so **a seller pulling an ask reads as buying
pressure when nothing traded at all.** On books this wide, that is not an
edge case; it is most of what a mid does overnight. The pathological entry is
buying a lifted ask because a seller left: instant loss of the whole spread,
booked as acting on "momentum."

Two gates fix it, both designed from the mechanism before measuring:

- **Bid momentum** (`momentumOnBid`): measure the move on the bid. A rising
  bid is a buyer actually paying more; it cannot be lifted by the ask side.
- **Traded-volume gate** (`requireTradeActivity`): refuse entries when no
  contracts printed during the momentum window. Quotes repositioning without
  prints is a market maker, not a move.

Measured on the recording (14–16 trades per row — direction, not proof):

| config | trades | win | PF | per trade |
|---|---|---|---|---|
| old ungated defaults | 15 | 27% | 0.25 | −$1.86 |
| bid momentum only | 16 | 25% | 0.41 | −$1.77 |
| volume gate only | 14 | 22% | 0.18 | −$2.68 |
| **both gates** | 14 | 29% | **0.54** | **−$1.03** |

**Both gates ship on by default.** Three reasons, in order: the mechanism is
sound independent of this sample; a gate can only refuse an entry, never
create a bad one, so its failure mode is trading less — the one direction
every measurement in this document has ever rewarded; and the real-data
result points the same way. The pair nearly halved the per-trade loss.

## Maker mode's first contact with reality

The synthetic worlds said maker entries cut losses; the fill worry was
whether fills arrive at all. Real data answered both, and not the way 1.5.0
hoped: **fills arrive readily (roughly half to two-thirds of resting orders
filled), and they were adversely selected enough to lose more per trade than
the taker rows** (−$2.97 vs −$1.03 on identical rules). The conservative fill
model was not pessimistic about fills — it was optimistic about what a fill
means. The Patient preset keeps its honest description and its experimental
status; the maker plumbing is exactly what makes collecting more evidence
cheap.

## Caveat, standing

One recording, one quiet Sunday night, a dozen trades per row. These numbers
choose directions, not truths. Every conclusion here is re-checkable in one
command against every future recording: `node scripts/replay.js`.

---

# 1.7.0: the plumbing catches up with the method

Three defects in the machinery around the strategy, found while using it.

## The app's own backtests had the seam bug

`scripts/replay.ts` learned in 1.6.0 to split recordings at gaps; the
Backtest page inside the app did not. Any recording with an engine stop and
restart replayed the seam as one 15-second price step — an hour of drift
read as momentum, traded by every configuration in the comparison. The
splitting now lives in the recorder (`segmentScans`) and both the app and
the script use it: a fresh engine per contiguous segment, one shared trade
ledger the way history.json persists across real restarts. There is a test
that hands the replayer a 5c jump across an hour-long gap and requires zero
trades, and the same jump without the gap and requires at least one.

## Recording died exactly when it mattered

Recording lived inside the trading loop, so the Backtest page had data only
while the bot traded — and a brake halt stopped data collection along with
the trading, which is backwards: the stretch after a halt is the one worth
studying. The app now records a sweep every 30 seconds while the engine is
parked (public endpoint, no keys, a toggle in Settings, on by default).

## The sweep learned to distrust its own winner

The parameter sweep is now on the Backtest page — 145 candidates, fitted on
the first 60% of the recording, scored on the 40% they never saw, sliced
across event-loop turns so the app stays responsive (measured at ~7ms per
candidate; the fear it would take minutes was wrong by two orders of
magnitude, which is why it was measured).

Its first run on real data produced the most seductive table this project
has generated: five maker configurations, all positive out of sample,
+$11.29 at the top. On **three trades each.** After searching 144
candidates. A grid that size lands a few candidates on whichever market
happened to move during a one-hour test window; that is not an edge, it is
a raffle. The sweep now says this itself — any winner whose out-of-sample
result rests on fewer than ten trades is labelled noise in its own output,
and there is a test that builds exactly that trap and requires the warning.

## Where the measurements stand after 63 minutes of real data

The full recording (254 scans, 240 markets, two segments):

| config | trades | win | PF | per trade |
|---|---|---|---|---|
| shipped defaults (both gates) | 15 | 33% | **0.71** | **−$0.70** |
| bid gate only | 22 | 36% | 0.68 | −$0.87 |
| pre-1.6 ungated | 18 | 39% | 0.55 | −$1.06 |
| volume gate only | 13 | 31% | 0.41 | −$1.63 |
| maker, same rules | 10 | 20% | 0.42 | −$1.82 |

The 1.6.0 gate decision held up on more data, with sharper attribution: the
bid gate carries most of the improvement, the volume gate adds a little on
top of it, and neither alone beats both. Maker entries stayed worse than
taker on identical rules — the adverse-selection finding repeats. Still
negative everywhere, still one night, still no edge claimed.

---

# 1.7.1: the brakes were holding the wrong ledger, and had no release

Three defects, reported from actual use, all in the risk machinery rather
than the strategy.

## Paper losses were arming the live brakes

`todayPnl()` and the losing-streak check read the whole trade history and
filtered it by date alone — never by `dryRun`. Paper and live are separate
accounts of separate money, and the engine was pooling them. A losing
practice run therefore spent the *live* daily loss budget, and could halt
live trading before it placed a single real order. The dashboard's
all-time P&L, win/loss record and win rate blended the two the same way,
reporting a history for an account that only ever held half of it.

Every brake and every statistic now reads only the mode the engine is
actually in, and the halt messages name which ledger they counted.

## A tripped limit could not be released

`start()` cleared the halt banner, and the first scan re-read the same
history, saw the same losses, and halted again. From outside, the Start
button did nothing. The documented escape — "raise or clear the limit in
Settings" — meant either raising a limit past a loss already taken or
deleting the trade history, which is a bad bargain: the record of what
went wrong is exactly what is worth keeping after it goes wrong.

Two changes. The engine now refuses to start with a message naming the way
out, instead of starting and stopping in the same breath. And there is a
**Resume** button that acknowledges the halt: the limit is not touched or
weakened, but the line it measures from moves to now, so the allowance
runs again from the moment the user chose to carry on. The acknowledgment
persists across restarts, and a fresh loss past the limit halts again.

## Settings silently restored the default it was told to replace

Emptying a number field to type a new value produces `NaN`, and the
settings sanitiser maps any non-finite number back to its factory default.
So clearing "Daily loss limit" and pressing Save wrote **50** — the app
appearing to refuse the change. Saving is now blocked while any box is
empty, and the blocked fields are named.

## And a reset that does not cost you your keys

With the halt inescapable, "Reset everything" was the only way out, and it
takes API keys, settings and saved setups with it. **Reset trading data**
clears results — trade history, equity curve, and any self-imposed halt —
while keeping keys, settings, saved setups and recorded market data. The
History page can also clear just the paper trades or just the live ones.

None of this changes a measurement in this document. It changes whether
the safety features can be lived with, which is what decides if anyone
leaves them switched on.

---

# 1.7.2: positions were going blind at the finish line

An audit pass found four defects, one of which quietly corrupted results.

**Held markets left the sweep, and the engine stopped seeing them.** The
scan covers the top forty by volume among markets closing within two hours
— so every held market is guaranteed to leave it, by closing if nothing
else. Once gone, the bid froze, the stop-loss could never fire, and a
market that settled was carried at its stale quote instead of the 100c or
0c that actually happened to the money. The engine now fetches quotes for
anything it holds that the sweep missed, manages it exactly as before, and
**books settlements properly**: YES at 100c, NO at 0c, no exit fee —
settlement is not a sale, and Kalshi charges nothing for it. This corrects
results in the flattering direction as often as not: a winner that rode to
a YES settlement was previously credited only its last stale bid.

**Live resting orders were abandoned at the exchange.** Only the TTL path
cancelled the real order; `stop()` and `flatten()` released the paper
reservation and told the user the order was cancelled while it kept
resting — and could keep filling — at Kalshi. Every local cancellation now
cancels at the exchange too, and an order id that arrives from Kalshi
after the local order was dropped is cancelled on arrival rather than
orphaned.

**Sanitise fallbacks had drifted.** A corrupted settings file fell back to
the pre-1.4.0 take-profit of 6c — under the fee floor those defaults were
specifically moved past. Fallbacks now reference the shipped defaults
directly.

---

# 1.7.3: the app must not die for a logged sin, or lie about starting

**One escaped promise rejection killed the whole app.** The global
`unhandledRejection` handler called the same fatal path as a startup
failure: an error dialog titled "failed to start" and a hard exit — while
the engine could be mid-session with positions open. The engine catches
its failures diligently, but a policy of "one missed catch anywhere ends
the trading session" is the wrong blast radius for a money app. A stray
rejection is now logged to crash.log and survived; uncaught exceptions
still exit (the process genuinely cannot be trusted after one), behind a
dialog that no longer claims a running app failed to start.

**The Start button toasted "Engine started" over a refusal.** `start()`
can decline when a brake is already tripped; the UI toasted success
anyway, over a stopped engine — success theatre stacked on top of a
safety refusal. The UI now believes the engine's answer, and a refusal
also raises an engine event, so starting from the tray — where there is
no banner — produces a Windows toast naming the reason instead of a
button that silently does nothing.

---

# 1.7.4: quits that wait, writes that land, and a regression of my own

**In-flight live orders died at quit.** `stop()` fires its closing sells
and cancels without waiting — right for a running session, wrong at quit,
where the process teardown killed whatever had not left the machine. A
closing sell that never arrives leaves a real position open with nobody
watching it. The engine now tracks live-order promises and the quit path
drains them behind a bounded timeout, so a dead network cannot hold the
quit hostage and a dry-run quit pays no toll at all.

**A crash mid-write could silently erase every trade.** Settings and
history were written in place, and the readers are deliberately tolerant
— so a torn `history.json` would not error; it would read back as an
empty array. All writes are now write-then-rename, which is atomic on the
same volume: the old file survives until the new one is whole.

**The 1.7.2 refresh reintroduced a hazard the sweep had always filtered.**
`getActiveMarkets` only returns two-sided books, so the exits had never
faced a bid of zero — but the held-market refresh let one-sided books
through, and a missing bid read as bid 0 would "stop-loss" a position at
a total loss on a trade that never happened. The refresh now requires
both sides, holding the position until quotes return.

**"Top forty by volume" was top forty of one API page.** The markets
query never followed the cursor, so the volume sort ran over whichever
thousand rows the server sent first. The fetch now follows the cursor a
few pages, verified against the live API.

---

# 1.8.0: what twenty minutes of real trading taught

The first live paper soak: 15 trades in 20 minutes, −$17.03, −$1.14 per
trade — almost exactly the −$1.03 the replay predicted, which says the
model is honest. The composition of the losses said the rest.

## Every trade was an endgame trade

All fifteen were hourly crypto ladders inside their final forty minutes —
because the sweep universe is *markets closing within two hours*, so
without a gate the bot lives permanently in the stretch where strikes
converge to 0c or 100c and "momentum" is mostly the resolution arriving.
New setting: **minMinutesToClose** (default 30) — no entries in markets
closing sooner. Close times now ride through the recorder, and a market
with no known close is let through rather than guessed at, so old
recordings replay unchanged.

## One trade lost $8.65 against a $2.40 design

Sizing by cost alone made dollar risk explode on cheap strikes: $10 at
15c bought 66 contracts, so the same 12c stop that costs $2.40 at 50c
cost $7.92. The engine now sizes by cost **and** risk: a stop-out may
consume at most a quarter of the trade budget, which reproduces the
historic sizing at mid prices exactly and only shrinks the tails — cheap
strikes and wide stops now risk the same dollars as everything else.

## Where the full recording stands (449 scans, 3 segments, 463 markets)

With risk-balanced sizing, the Patient preset posted the first positive
full-configuration row this project has produced on real data: **PF
1.04, +$0.56, 56% win rate — over 16 trades.** That is breakeven noise,
not an edge, and it gets the same discount the sweep's own output
applies to its nine-trade winners. What it is: the same configuration
that has measured least-bad on every dataset — maker entries, strict
gates, fewer trades — now hovering at zero instead of bleeding. The next
soaks run Patient, and more hours of recording will say whether zero is
where it lives or where it passed through.

---

# 1.9.0: the maker exit, built, measured, and left off

The remaining fee lever: a winning exit sells at the bid and pays the
taker fee — two to three cents per contract handed back on every winner.
1.9.0 adds **makerExits**: the take-profit rests as a sell at the target
from the moment a position opens, fills at the target fee-free, and dies
with the position on any other exit. Stops are untouched — a stop that
waits politely at the ask is not a stop. Live mode places real post_only
sells, polls them, cancels them when the position closes another way,
and carries the same late-id race guard as entries.

Measured on the full recording (476 scans, 4 segments): **no advantage.**
Defaults −$25.22 without vs −$26.16 with; Patient +$6.80 without vs
+$5.79 with. The mechanism explanation cuts both ways: on 15-second data
the instant taker exit sells at bids that gap *past* the target, and
that overshoot roughly pays the fee it costs. So the feature ships off
by default, because the measurement outranks the theory that motivated
it. One honest caveat, recorded rather than acted on: the conservative
paper fill model cannot credit real queue fills at a merely-touched
target, so live maker exits likely do somewhat better than paper shows.
A future live soak can say.

Same table, the headline: **Patient at PF 1.43, +$6.80, 65% win over 20
trades** — strengthening as the recording grows, still a small sample,
still not a promise. The soaks continue.

---

# The first positive live session

Three hours of the 1.9.0 build running the Patient preset, paper cash,
every 1.8.0 mechanism active. **24 trades, +$16.05. Eighteen
take-profits (+$29.32) against six stop-losses (−$13.27): 75% win rate,
profit factor 2.21, +$0.67 per trade.** The wins were spread across
several hourly ladders, not one lucky market; the losing hour (the
07:00 BTC ladder, −$5.90) was carried by the others. Every stop cost
about $2.21 — the risk cap holding, no more $8 bombs — and the close
gate was visibly refusing final-minutes markets all session.

For contrast, the same morning had already produced two losing stints:
−$17.03 on the ungated defaults and −$10.15 on eight minutes of Patient
around an hourly rollover. One good afternoon does not cancel the
standing caveat, and does not promise the next session anything.

What can be said with a straight face: over 307 minutes of recorded
market and 955 distinct markets, the replay now scores Patient at **PF
1.45, +$7.49, 64% win (22 trades)** — positive and stable at every
dataset size since the 1.8.0 mechanisms landed — while every other
configuration measures negative, and Patient without its regime filter
measures −$13.21. The stack earned its keep piece by measured piece.
The live session beat its own replay, which is consistent with the
recorded caveat that the paper fill model refuses touch-fills a real
maker would receive.

Still one Sunday. The soaks continue, and the numbers keep deciding.

---

# 1.9.1: the evening took the shine off, and named another mechanism

While the streak brake held the engine (four straight losses — three of
them S&P index hourlies traded within minutes of entering the sweep at
the Sunday futures open, one gapping 24c through a 12c stop), the
passive recorder kept collecting. The dataset grew to 1,765 scans over
550 minutes and 1,512 markets — and on the full recording **Patient
went negative: −$9.47, PF 0.47.** The morning's positive readings did
not survive the evening's regime. That is precisely what "noise until
it repeats" was for; it did not repeat, and this document says so in
the same breath it reported the win.

What holds at every dataset size: the ranking. Patient remains
least-bad by a wide margin (defaults −$40.68 on the same data), its
filter stack is worth +$10.76 of attribution (−$9.47 with, −$20.23
without), the risk cap kept every stop near its design cost, and the
day's live equity finished positive (+$6.93) even after the losing
stints.

---

# 1.9.2: one disproof per market

The autopsy of the first 55 live trades, by the cut that mattered:

| cut | result |
|---|---|
| held under 2 minutes | 17 trades, 2W/15L, **−$29.89** |
| held over 2 minutes | 38 trades, net **+$5.15** |
| re-entries into a ticker already down today | 8 trades, 1 win, **−$11.36** |
| first meeting with a ticker | 47 trades, −$13.38 |
| stops gapping past the line | 14 of 24, $6.75 of slippage |

The whole net loss and more lives in trades that died within two
minutes, and a fifth of every dollar lost came from re-buying markets
that had already stopped us out. A stop-out is the market disproving
the signal right there; the 90–120 second cooldown then let the same
dying momentum re-trigger. **After a losing exit, the ticker now locks
out for an hour** — effectively the rest of these markets' lives, so
the rule is one disproof per market. Winning exits keep the short
configured cooldown, because re-entering strength is a different claim,
and a cooldown of zero still disables everything.

On the recording as it stands (2,152 scans, 647 minutes, six
segments), Patient reads **−$3.86, PF 0.78** — its best full-dataset
figure since the hostile evening entered the data — while ungated
defaults sit at −$48.27. Different datasets before and after the
lockout, so that is direction, not attribution; the one-for-eight live
record is what earned the change.

Also observed and deliberately not acted on: entries between 45c and
65c ran 4W/13L (−$21.95). The band has a mechanism smell — peak fee,
maximum uncertainty — but seventeen trades is a coin reading, and the
price-band settings already let anyone act on it by hand.

---

# 1.9.3: a clock bug was flattering the replays — corrections

The sweep reported zero trades for every candidate across a thousand
held-out scans, and total replay trade counts were *shrinking* as the
recording grew. Impossible market behaviour, so it was machinery: the
1.8.0 close-time gate measured "minutes to close" against the wall
clock instead of the scan's own clock. In a replay, every recorded
close time is in the past — so every market recorded by a 1.8.0+ build
replayed as "closing soon" and was silently refused. Fixed to use the
scan timestamp, with a regression test that replays a week-old
recording and requires it to trade.

**Corrections to this document.** Every replay figure computed between
1.8.0 and this fix ran on partially-zeroed data: the "Patient PF
1.04/1.43/1.45" readings, the "+$10.76 / ~$20 filter attribution", and
the lockout's "−$3.86" figure all overstated things by excluding the
newest — often hardest — scans from every configuration equally. They
are retracted as measurements. The **live** sessions were never
affected (they are actual paper trades, not replays): the +$16.05
afternoon and each losing stint stand as reported.

**The honest full-recording verdict** (2,597 scans, 796 minutes, 7
segments, 1,896 markets, Sunday night through Monday): every
configuration is negative. Defaults −$100.66 over 140 trades; Patient
−$57.50 over 86 (PF 0.50), now roughly level with Patient-no-filter
(−$54.63); maker entries remain the least-bad entry mechanic. The
sweep's best out-of-sample candidate loses $30 on 28 unseen trades,
and its own output says what that means. On thirteen hours of real
recorded market, nothing here has an edge — which is what this
document has said from the start, now measured with a clock that
tells the truth.

The mechanism 1.9.1 adds came from both live loss clusters telling the
same story: **the engine was trading markets it had only just met.**
The regime filter abstained below nine samples — waving through exactly
the markets it could not certify. With the filter on, a market now has
to be watched for nine scans before it can be judged tradeable; a
flat-but-well-observed book that wakes up still passes, because a quiet
market breaking out is the one thing a momentum rule exists for. This
reverses a deliberate earlier choice, and the test that encoded the old
choice now encodes the evidence.

---

# 1.10.0: one ladder is one bet

The Monday-evening soak wrote the cleanest mechanism picture this
project has produced. Five take-profits in a row riding one BTC hourly
rally — then four stop-losses inside three minutes when the same rally
pulled back, tripping the losing-streak brake and parking the engine
for the night. All four "consecutive" losses were adjacent strikes of
the same KXBTCD ladder. One market move, booked as four independent
losses, judged by the brake as a losing streak.

The full history says this was the pattern, not the exception: **37 of
77 entries stacked onto an event ladder already held** (up to three
deep), and **18 of 34 stop-losses arrived in same-ladder cascades** —
seven cascades, −$47.27, more than half of everything the stops ever
cost. The engine also once re-entered a sibling strike 45 seconds into
a cascade and stopped out instantly: the loss lockout was honoring the
exact ticker that lost while buying the strike next door.

Two mechanisms ship:

- **maxPositionsPerEvent** (default 1): at most one concurrent
  position — resting orders included — per event ladder. Sibling
  strikes price the same underlying; holding three of them is one bet
  at triple size.
- **The loss lockout widens from ticker to ladder**: a stop-out on one
  strike locks every sibling for the hour. Winning exits keep the
  short ticker-scoped cooldown — strength continuing into the next
  strike is a different claim — and cooldown 0 still disables both.

**What the replay says, honestly:** on 3,041 scans (957 minutes, 8
segments, 2,400 markets) the cap changes expectancy by nothing worth
claiming — defaults −$102.26 over 116 trades against −$97.47 over 170
with the cap off. Both dreadful; the gap is noise. The cap is not an
edge and this document will not pretend it is one. Its case is the
thing the replay cannot see: replays run brakes-off, so they never pay
for a correlated cascade tripping the streak brake — which live cost
an evening of uptime and counted one market move as four losses. The
cap is a risk-shape default, adjustable in Settings like the global
position cap it sits next to.

# And a second clock bug, caught by the first one's rule

The 1.9.3 rule — anything in the scan path uses the scan's own clock —
turned out to have a second violator: cooldowns and lockouts were set
and checked against the wall clock. In a replay, where an hour of
market time passes in seconds of wall time, **no cooldown ever expired
and no loss lockout ever ended.** Every replay since the lockout
shipped in 1.9.2 (including 1.9.3's "honest verdict" figures) ran with
effectively permanent per-ticker lockouts — a conservative bias
(fewer re-entries than the live engine would take), unlike the 1.9.3
bug, but a wrong clock all the same. The engine now carries a single
scan clock, set by live ticks and by every replay driver, and the
cooldown machinery, trade timestamps and lockouts all read it. A
regression test advances scan time with milliseconds of wall time and
requires the cooldown to expire on schedule.

The corrected full-recording verdict, with both clocks telling the
truth: everything is still negative. Defaults −$102.26/116, Patient
−$55.38/57 (PF 0.34), the sweep's best out-of-sample candidate −$5.74
on 31 unseen trades — every candidate loses on data it had not seen.
Sixteen hours of recorded market, no edge anywhere in the grid. The
live sessions stand as reported; Monday evening net −$1.54 (5W/5L),
with the win side and the loss side both concentrated in the one
ladder this release is about.

---

# 1.10.1: a stop that cannot fire is not a stop

Found by Monday evening's flatten, generalised by the sibling
Polymarket bot hitting the same wall from the percentage side the
same week. The stop-loss exit waits for the bid to fall stopLossCents
below entry — so from an entry at or under that distance, the trigger
price is zero or negative, somewhere no bid can go. A 10c entry with
a 12c stop has no stop at all: one rode 10c down to 1c for 64
minutes, −91% of its cost, and only closed because the engine was
stopped. Its true risk was the entire stake, and the risk-balanced
sizing was quietly computing with a fiction.

The gate refuses entries at or under the configured stop distance and
says so in the signal feed. Not measured in replay — a dead stop is a
correctness defect like a crossed book, not a strategy to A/B; the
figure that motivates it is the −91% ride that a working stop would
have cut at −12c. Entries one cent above the distance stay allowed:
a thin stop is thin, but it exists, and Monday's one 13c entry with a
1c-deep stop took profit at +16c.

The overnight chop session (5h, 9 trades, −$8.36, 7 stops/2 TPs)
gets its honest line too: the 1.10.0 ladder rules held — losses
spread across seven different ladders, no stacking, no cascade — and
the streak brake halted on four consecutive losses that were, for the
first time, genuinely independent. The strategy still loses in chop.
Nothing here claims otherwise.

---

# 1.11.0: a staircase is momentum; a jump is a head-fake

The momentum trigger measures net change over the window, so a single
gapped tick that then mean-reverts qualifies exactly like a steady
climb - and the autopsied instant-stop cluster was full of that shape.
The climb gate (requireConsistentMove) demands that strictly more than
half of the window steps rise; flat steps count against, deliberately,
because one jump followed by two flat scans is a move the market is
sitting on, not making.

Measured on 5,531 recorded scans (27 hours of market, 9 segments,
4,001 markets) before any default changed: the gate refused 15% of
default entries and improved every number that survived - P&L
-$131.70 against -$170.76, per-trade -$0.92 against -$1.02, win rate
45% against 43%, profit factor 0.46 against 0.43. Everything is still
negative; this is a smaller shovel, not a ladder out. It ships ON by
the same standard as the 1.6.0 gates: a pure-refusal gate that
measured better on real data can only skip a trade, never create one.

The same replay also re-scored the ladder cap on the grown recording:
cap off now reads -$221.77 over 281 trades against -$170.76 over 168
with the cap - on this larger dataset the cap side is better in total
and the earlier "no material difference" reading has aged toward the
cap. Still noise-adjacent per trade; the risk-shape argument remains
the real case.

The History page now carries the exit-reason breakdown and the
under-two-minute stop count - the first two cuts of every autopsy this
document has ever run - so the person running the bot sees what the
analysis sees without exporting a CSV.

# 1.12.0: the fee is a hill, and the bot was standing on top of it

Three days of recorded books — 5,538 scans, 9 contiguous segments, 4,043
distinct markets, about 27 hours of market time. Everything below comes from
that one file. Three new scripts do the work and are kept: `edge.ts` asks
whether the signal predicts anything, `optimize.ts` searches a grid and reports
what each setting is worth on average, `validate.ts` scores a short list one
segment at a time.

## First, the number that had to come before any tuning

Replaying the shipped defaults: **143 trades, 45% win rate, profit factor
0.46, −$131.70**. Every preset loses. The in-app sweep's 144 candidates all
lose out of sample; its best is −$7.52. That was already known. What was not
known is *why*, and no amount of parameter search can answer that.

So `edge.ts` measures the thing underneath: from an entry, does the bid reach
`entry + takeProfit` before `entry − stopLoss`? That barrier race is what the
win rate is made of, stripped of sizing, brakes, cooldowns and ladder caps.
89,979 tradeable observations.

The taker's problem turns out to be arithmetic, not prediction. A taker buys at
the ask and marks at the bid, so the position opens the spread underwater: at a
3c spread and a 12c barrier it needs 15c up to win and only 9c down to lose,
before the signal has said anything at all. Break-even on a 12c/12c taker trade
near 50c is **64.6% of decided races**. The best the trigger reaches is 48.7%.

## What the gates are actually worth

Measured on the same races, each shipped gate in isolation:

| filter | n | mean 10-min bid move | taker YES wins |
|---|---|---|---|
| trigger ≥ 4c | 16,072 | −1.61c | 35.5% |
| + traded volume | 10,913 | −1.00c | 40.7% |
| + consistent climb | 12,625 | −1.47c | 37.6% |
| + both gates | 8,870 | −0.99c | 41.6% |
| + both, spread ≤ 2c | 5,492 | **+0.71c** | 48.7% |

Both gates earn their place, and the spread limit earns more than both of them
together. It is also the only row in the table where the forward move is
positive: after the gates, in a tight book, the bid does drift up. **The signal
is real and it is worth about 0.7c a contract.** A maker pays 1.75c to exit
near 50c. That is the whole story of every losing backtest this project has
produced: the edge exists and is roughly 40% of the size of the fee charged to
collect it.

## The hill nobody had looked at

Kalshi's fee is `0.07 × P × (1 − P)` per contract per side. That is not a
constant — it is a hill, peaking at 50c and falling away at both ends:

| price | fee per side |
|---|---|
| 17c | 0.99c |
| 33c | 1.54c |
| 50c | **1.75c** |
| 67c | 1.54c |
| 80c | 1.12c |

The shipped price band is 10–85c. It spans the peak and spends most of its
trades on it. Nothing in the app ever said so; the band read as a taste in
markets when it is also the largest single lever on what a round trip costs.

So the same races, cut by entry price, each priced against the fee actually
charged there:

| band | n | fee/side | mean 10-min move | maker wins | needs | margin |
|---|---|---|---|---|---|---|
| 10–25c | 602 | 1.02c | +1.33c | 48.1% | 54.3% | −6.2pt |
| 25–40c | 966 | 1.54c | +0.52c | 49.9% | 56.4% | −6.5pt |
| 40–60c | 1,423 | 1.75c | +1.52c | 51.8% | 57.3% | −5.5pt |
| **60–75c** | 1,321 | 1.54c | **+2.67c** | **58.3%** | 56.4% | **+1.9pt** |
| 75–85c | 1,180 | 1.12c | −2.64c | 57.1% | 54.7% | +2.4pt |

Two bands clear their own break-even. Only one of them clears it honestly.
75–85c wins more races than it needs to and still drifts down 2.6c, which is
the signature of a fat left tail: the barrier race scores a −60c collapse and a
−12c stop identically, and up there the collapses are what pays for the pennies.
60–75c is positive on both measures at once.

## The grid agreed, afterwards, which is the right order

`optimize.ts` scores each candidate on four consecutive slices of the recording
and reports the **marginal** for each axis — the average over every candidate
holding that value while everything else varies. A grid always has a top row
and the top row of a wide grid is a lottery winner; a marginal is a claim about
dozens of different companions.

| axis | value | trades | avg per trade |
|---|---|---|---|
| price band | 10–85c | 2,084 | −$0.33 |
| | 25–75c | 1,896 | −$0.41 |
| | 55–80c | 1,465 | −$0.23 |
| | **60–75c** | 1,279 | **+$0.17** |
| take-profit | 12c → 40c | | −$0.38 → −$0.09 |
| stop-loss | 8c → 30c | | −$0.35 → −$0.17 |
| max spread | 2c → 1c | | −$0.30 → −$0.15 |
| maker entries | off → on | | −$0.60 → −$0.47 |

Every axis is monotone. The band is the only one whose sign changes.

Per segment, against the defaults:

| config | total | trades | win | segments up |
|---|---|---|---|---|
| shipped defaults | −$131.70 | 143 | 45% | 1 of 9 |
| Patient preset | −$58.47 | 86 | 38% | 0 of 8 |
| **60–75c, tp30 sl20, maker** | **+$17.64** | 33 | 58% | 5 of 7 |
| same rules, band 10–85c | −$2.78 | 41 | 44% | 3 of 8 |
| same rules, band 75–90c | −$13.19 | 27 | 48% | 2 of 7 |
| same rules, band 10–40c | −$8.11 | 38 | 39% | 1 of 6 |

The band is doing the work: identical rules outside it lose.

## What that is worth, stated plainly

Thirty-three trades. Twelve of them were still open when the recording ended
and were marked out rather than closed by a rule. The win rate is 58% where
43% would break even, but on 21 decided races that gap is about 1.4 standard
errors — nowhere near significance. One recording, three days, one exchange.

What makes it worth shipping anyway is that it was not found by ranking a grid.
The fee formula predicted where to look, `edge.ts` measured it on 1,321
observations, and the grid agreed afterwards across 32 unrelated rule sets. Two
methods, one mechanism, same answer. That is a hypothesis worth paper-trading,
and it is offered as exactly that.

## Shipped

- **A "Fee band" preset.** 60–75c, resting at the bid, 30c target with 20c of
  room, 1c spread limit. Its description says it is the only configuration
  measured that made money, and that 33 trades is far too few to call an edge.
- **The fee curve, shown where the band is chosen.** Settings now prints what
  the round trip costs at the bottom, middle and top of the chosen band, and
  says outright when the band contains the 50c peak.
- **A strike column that stops inventing a strike.** A single-outcome market —
  "ETH price up in next 15 mins?" — carries a `00` placeholder where a ladder
  carries its strike, and the Signals page was formatting it as a strike of
  zero: a price the market will never trade at, in the column a trader scans
  for the line being bet on. Second most common ticker shape in the recording.
  Those rows now read "open" and their group says "1 market" rather than
  "1 strike".

## Caveat, standing

The defaults did not change. A preset is an invitation to test something; a
default is a claim, and 33 trades does not support one. Nothing here has a
demonstrated forward edge, and the app still opens in dry-run.

# 1.14.0: the measurements were wrong, and fixing them killed the best result

Two open-source Kalshi bots were read end to end for this release —
[OctagonAI/kalshi-trading-bot-cli](https://github.com/OctagonAI/kalshi-trading-bot-cli)
and [alsk1992/CloddsBot](https://github.com/alsk1992/CloddsBot), both MIT. Almost
nothing was taken from their strategies. What was taken was their **scoreboard**,
and it invalidated the most promising result this project had produced.

## The fair-value model looked like the first real edge

1.13.0 shipped a model that prices the UNDERLYING rather than the contract. A
crypto ladder settles on BTC, so given spot, realized volatility and the minutes
remaining, a strike has a computable probability. Kalshi settles on the mean of
roughly sixty one-second index prints over the final minute, so the variance of
that average — `σ²·Σi²/n²`, about 0.342 minutes of ordinary diffusion — is what
the model uses near expiry, and prints already observed inside the final minute
are banked rather than treated as risk.

Its first run: **twenty-one signals, twenty-one correct, Wilson lower bound
88.6%.** The first thing in this investigation that had not immediately died.

It was an artifact. Three separate errors, all of them mine.

### 1. Wilson assumes independent trials, and these are not

A Kalshi event carries a ladder of strikes over ONE underlying path. "Above
78,000", "above 78,500" and "above 79,000" in the same hour are decided together
by the same move. Three rows, one outcome. Counting them as three successes
shrinks the interval by a `sqrt(3)` that was never earned, and over a dozen
strikes the overstatement is severe.

Octagon's own test names the trap exactly: *the row bootstrap thinks N is a
hundred when the honest N is twenty.* Intervals now come from a cluster
bootstrap that resamples EVENTS, and both intervals print side by side so the
manufactured confidence is visible rather than argued about. On the corrected
run the clustered hit-rate interval was **[42.4%, 54.1%]** where the naive one
claimed **[45.3%, 51.1%]** — not merely narrower, but excluding most of the real
range.

### 2. 61% of these markets settle NO

Measured on this app's own settlement record: 414 NO against 263 YES. An event
has one true outcome and many strikes that miss it, so the universe is
structurally tilted. Any strategy leaning NO harvests that tilt and looks like a
forecaster; comparing a win rate against 50% compares it against a baseline
nobody offers.

Every number is now reported beside the same arithmetic with the model switched
off — always-YES and always-NO over the identical rows, **each paying its own
ask** rather than being handed a free crossing of the spread — and the DELTA is
the only part that is about the model. Within-band skill repeats the comparison
inside entry-price buckets, because a model that only buys 90c favourites beats a
whole-book baseline on price alone.

### 3. The exclusion rate was measured in the wrong unit

Sample health is the one number the report tells the reader to check first, and
it compared two different things: the usable side was deduped to one row per
market, the missing side counted every sweep. A market scanned forty times
contributed forty to the numerator and one to the denominator, so the ratio
measured scan frequency rather than coverage. It read 87% missing. Counting
distinct markets on both sides, it was **8.1%**.

That inverts what the result means rather than adjusting it. A negative verdict
on 5% of a population is a shrug; the same verdict on 92% of it is an answer.

## The corrected verdict

1,104 markets, **126 independent events**, 8.1% missing:

| | model | best dumb baseline |
|---|---|---|
| P&L per contract | **−3.59c** | −1.54c (always NO) |
| skill vs book | **−2.2%**, CI [−6.6%, +1.8%] | — |
| loses in | **4 of 5 price bands** | — |

The signals arm is the clearest line in the run: it hits **88.5% and still loses
3.35c**. Winning 88.5% is a loss when the entry cost 92c — it needed 93%. Its
directional calls were good; it expressed them at a price that ate the edge.

Skill is `1 − brierModel/brierBook`. Positive means the model carries
information the price does not. Zero means it is an expensive way to reproduce
the ask.

## Nobody had asked what settled

The exclusion rate was never a slow sweeper. The settlement sweeper only asks
about markets it has SEEN — `noteMarkets` adds a ticker when a scan observes it
— so everything recorded before the sweeper existed was invisible to it
permanently: **3,933 closed markets that had never once been looked up, against
679 that had.**

`scripts/backfill.ts` asks for all of them at eight a second. **3,840 answered,
zero failures.** They had been sitting there settled for days, one public GET
each, against a documented budget of two hundred reads a second.

Spot history was the other half of the same wall. One Coinbase request returns
350 one-minute candles — under six hours — so only markets too recent to have
settled could be priced. `fetchCandleHistory` pages backwards instead, and sigma
is computed ONCE over the merged series: computing it per page would leave the
first hour of every chunk with a truncated window, a volatility sawtooth
recurring every 300 minutes that would make the model most confident exactly
where it knew least.

## So the question underneath got asked at last

Six studies had asked whether some IDEA beat the book. None had asked whether
the book is wrong at all. `scripts/calibrate.ts` takes one quote per settled
market at a fixed horizon, buckets by price, and compares against what happened.

**The book IS mis-calibrated.** At thirty minutes out the gap runs negative in
eleven of twelve buckets — markets settle YES less often than their price
implies, by as much as **−10.1pp at 70-80c**.

**It is still not money.** After the spread and the one-lot fee, not one bucket
on either side has a clustered interval that clears zero. Buying YES is reliably
negative in six of them; the buy-NO positives on favourites all straddle zero.
The tilt is real and smaller than the cost of acting on it, which is the
ordinary condition of a market that works. At sixty minutes the gap reverses
sign — suggestive only, because that is a different population.

## And the tape says nothing either

The last unused input: 473,571 real prints carrying `taker_outcome_side`, which
names the aggressor. Quotes are opinions and cost nothing to post; a trade is
somebody spending money.

Asking whether order-flow imbalance predicts YES is worthless on its own, because
heavy buying pushes the price up and the price already predicts YES — flow
"predicts" the outcome because flow is most of what MADE the price. So
`scripts/flow.ts` measures the RESIDUAL: realised settlement minus what the book
was already quoting. Best coverage, 209 markets and **143 independent events**:

```
sold hard  −14.2pp     bought       −4.4pp
sold        −2.8pp     bought hard  −5.1pp
balanced    −3.5pp
```

The column does not rise with buying pressure. Between the tails, bought −4.6pp
against sold −5.2pp — a difference of **0.6pp** with overlapping intervals.
Flat. The persistent negative level is the same YES-overpricing the calibration
study found, and belongs to the book, not the flow.

Across roughly sixty tests — six parameter sets, five thresholds, two directions
— exactly **one** interval cleared zero, on eleven events. That is fewer winners
than chance alone produces. The sweep now applies the same twenty-event floor
`sizing.ts` enforces and prints such rows as SUPPRESSED with their event count.
A study that recommends what the sizer would refuse is a study arguing with
itself.

## Both sides of the trade are now closed, for different reasons

- **As taker** — the spread plus the fee exceeds the book's mispricing in every
  band. Structural, and *not* fixed by polling faster: speed does not shrink a
  spread or a fee.
- **As maker** — the fee is genuinely $0.00 on these series, but resting orders
  eat **−12.4pp of adverse selection**, because a resting bid only fills on a
  downtick and a downtick is informative. Mechanical, not bad luck.

Seven strategies measured, seven negatives, and the free inputs are exhausted:
quotes, settlements, spot, and now the tape.

## What the instrument itself cannot see

The recorder keeps the top forty by volume, and volume arrives near expiry, so
**the median market is in the recorded universe for only ten minutes** (p25 2,
p75 38, p95 70). Anything needing a longer view of a market has no data behind
it and cannot be backtested here — worth knowing before designing one, and it is
why the sixty-minute calibration run quietly switches to a long-lived
subpopulation.

## Shipped

- **`skill.ts`** — Brier, skill-vs-book, event-clustered bootstrap, zero-skill
  baselines, within-band skill, and per-slice strategy tags (`BTC_YES_e02-04_t05-15`,
  adapted from CloddsBot: one number for a strategy hides the case where half its
  slices pay and half bleed). The seeded generator is this app's own — an
  interval that moves between runs cannot answer whether a change helped.
- **`sizing.ts`** — Kelly with the safety catch welded on. The old `sizeFactor`
  comment rejected Kelly because it needs a trusted edge estimate; that objection
  was right, and `skill.ts` is what answers it. It refuses any size below twenty
  independent events or a skill interval touching zero, and shrinks the model's
  probability toward the book by the clustered lower bound — so an unproven model
  prices at the market and sizes at zero **by construction**, not because a
  caller remembered to check. The fee is folded into the cost rather than
  subtracted after, which at 85c is a whole cent against a fifteen-cent payoff.
  **Nothing is wired to an order.**
- **`depth.ts`** — the last free input Kalshi publishes that this app never
  stored, and the only one that cannot be backfilled: a resolved book is gone.
  Five levels a side, forty markets every thirty seconds. Kalshi returns two BID
  ladders, not a bid side and an ask side, both ascending — a NO bid at 21c is
  somebody offering YES at 79c — so the NO ladder is mirrored into one book in
  YES cents, pinned by a test against a real captured response.
- **The History page stops flattering the trade count.** It showed a win rate
  and a per-trade figure with no interval and no honest denominator, so fifteen
  trades across three ladders read as fifteen independent results. `computeMetrics`
  now reports `events` alongside `trades`, both headline numbers carry
  event-clustered intervals, and where the counts diverge by more than a factor
  of two the page says so in words — a widened interval with no explanation reads
  as a worse result rather than an honester one.
- **`backfill.ts`, `calibrate.ts`, `flow.ts`**, and a rewritten `fairvalue.ts`.

## Known, and deliberately not changed here

There are two `eventOf` implementations and they disagree. `TradingEngine.eventOf`
strips only a `-T…`/`-B…` strike suffix; `skill.eventOf` splits at the last dash.
Measured across 4,519 settlements they agree on the crypto threshold ladders and
disagree elsewhere: KXCRYPTOLEAD15M has up to five siblings per event that the
engine's rule reads as five separate events, and KXDJI and KXAPRPOTUSD are worse
— so `maxPositionsPerEvent` and the ladder loss-lockout do not fire on those
series. The fifteen-minute crypto series are unaffected: they carry exactly one
market per event.

`metrics.ts` uses the broader rule, which is correct for measurement. Widening
the ENGINE's is a live-behaviour change and is left as its own task rather than
smuggled into a metrics release.

## Caveat, standing

Stronger than it has ever been. Seven strategies have now been measured against
event-clustered intervals and dumb baselines, and all seven lost. The app opens
in dry-run, nothing here has a demonstrated forward edge, and the honest reading
of this release is that the measurements finally became good enough to say so.

# 1.15.0: the instrument becomes the product

Seven strategies measured, seven negatives, and the free inputs exhausted —
quotes, settlements, spot, the tape and now the order book. The research is
finished. What that leaves is an awkward fact: the valuable half of this project
was never the bot, it was the apparatus that proved the bot does not work, and
that half has only ever existed in `scripts/`. Clone the repo, install a
bundler, run node. Someone who downloaded the installer got the losing strategy
and none of the evidence.

So the studies start moving inside, and this release moves the first one.

## The Evidence page

It shows what the app has actually collected — quotes from the sweep, outcomes
from the settlement sweeper, the trade tape, spot, and the order book — and runs
the question that sits underneath every strategy: does a price on this venue
mean what it says, and is any error big enough to trade through the spread and
the fee?

No API key, no network. It reads only what the app already wrote for itself.

On the recording that exists today it reports 1,878 settled markets across 465
independent events in under a second, and reproduces what the script version
found: the gap runs negative through the upper bands (−7.8pp at 70-80c, −8.1pp
at 90-95c), the buy-NO positives on favourites all straddle zero, and no band
survives its fees. The verdict it prints says the book may well be mispriced and
not by more than it costs to act on — which is the ordinary condition of a
market that works.

## The refusals are the point

`calibration.ts` carries the same discipline the scripts do, and the suite pins
each one:

- **One observation per market**, at a fixed horizon before close. Every
  recorded quote would let a market that stayed liquid for six hours outvote one
  that went quiet, and would count a single outcome hundreds of times. The last
  quote before close would bias toward the extremes, because a market drifts to
  0 or 100 as it resolves.
- **Event-clustered intervals**, which matter more here than anywhere else in
  the app: the strikes of one event land in DIFFERENT price buckets, so one BTC
  move fills the 90c bucket with winners and the 10c bucket with losers at the
  same instant, and none of that is independent evidence.
- **Each side pays its own ask.** Pricing NO as 100 minus the YES ask hands the
  baseline a free crossing of the spread on every row, which on a 3c book is
  worth more than any edge under discussion.
- **Expected value per row, never from a bucket average**, because averaging the
  price and then pricing the average smooths away exactly the fee non-linearity
  that decides whether a deep favourite is worth buying.
- **A band is tradeable only if its whole clustered interval clears zero AND it
  rests on enough independent events to size against.** Anything less is
  reported as suppressed with its event count. The position sizer would refuse
  it, and a study that recommends what the sizer refuses is a study arguing with
  itself.

## Also

`computeMetrics` and the History page were already corrected in 1.14.0 to count
events rather than trades. This release makes the same standard reachable from
the navigation rather than from a terminal.

Two layout defects were caught by rendering the page in a real compositing
Electron window against a throwaway profile — the stat cards were stacking
full-width because the wrapper needs `grid stats` rather than `stats`, and the
root carried a class this stylesheet has never defined where every other page
uses a fragment. Neither would have shown up in a typecheck.

## Caveat, standing

Unchanged, and now easier to check. Nothing here has a demonstrated forward
edge, the app opens in dry-run, and the Evidence page is free to tell you so
using your own recording rather than mine.

---

# 1.15.1: the ladder cap was not looking at most of the ladders

1.10.0 shipped two rules that both rest on one question: which markets
settle together? The engine answered it with a regex that stripped a
`-T…`/`-B…` strike suffix, so `KXBTCD-26AUG2420-T78699.99` and
`-T78799.99` were one ladder. Correct, and far too narrow. A Kalshi
market ticker is `SERIES-EVENT-OUTCOME`, and only threshold and range
ladders write that last segment as a strike.

Everything else fell through. Measured over the settlement record,
**nine series carried siblings the engine read as one event per
market**, so `maxPositionsPerEvent` and the hour-long ladder lockout
never fired on them at all:

| series | how it writes an outcome | siblings |
| --- | --- | --- |
| KXCRYPTOLEAD15M | `BTC`, `ETH`, `SOL`, `XRP`, `HYPE` | up to 5 |
| KXDJI | `53190.00` | up to 7 |
| KXAPRPOTUSD | `39.1` | up to 9 |
| KXYTVIEWSW | `14.5M` | up to 5 |
| four football series | `NEG`, `KUA`, `TIE` | 3 |
| KXCBDECISIONKOREA | `H25`, `HOLD` | 2 |

KXCRYPTOLEAD15M is the sharpest of them. Its five outcomes are
mutually exclusive — exactly one coin leads the quarter-hour — so
three positions in one lead market is a single bet at triple size that
cannot pay out more than once, and the engine was free to hold all
five. This is the same defect as 1.12.0's strike column inventing a
strike of zero, one layer down: the ticker's last segment is not
always a price, and code that assumes it is gets a wrong answer
quietly.

Nor was the shape rare. The recorded sweeps held siblings the old rule
split in **886 of 3,950 scans** in the live log and **1,088 of 5,607**
in the archive, up to nine deep. The scan logs also name series the
settlement record has not caught up with yet — the AAA gas-price
ladders, the KBO baseball series, `KXRAIN` — so nine is a floor.

## The fix, and why it is the boring one

`skill.eventOf` — written for the measurement scripts, and already
used by the event-clustered confidence intervals — splits at the last
dash and gets every one of these right. The engine now calls it. One
definition, so the risk limits and the studies that grade those limits
cannot disagree about what an independent event is. Two definitions is
how they came to disagree in the first place.

Audited before adopting rather than after. Every ticker this app has
ever written down — settlements, backfill and both scan logs, **5,523
distinct tickers across 119 series** — has exactly three dash-separated
segments. Not one can collapse to its series, which is the only way
splitting at the last dash could merge two events that are genuinely
separate. Adjacent 15-minute windows stay apart, which is also why the
fourteen 15M series were unharmed by the old rule: each of those
markets is the only rung on its own ladder.

## What the replay says, honestly

Two entries refused across both recordings, none created, and the
take-profit counts do not move — only stop-losses disappear.

| recording | trades | P&L |
| --- | --- | --- |
| live log, 3,950 scans | 118 → 116 | −$77.29 → −$69.89 |
| archive, 5,607 scans | 155 → 154 | −$129.80 → −$122.70 |

Two trades is not a measurement and this document will not dress one up
as an edge. The standard 1.10.0 was held to applies here unchanged: the
cap's case is the risk shape, not the expectancy, and replays run
brakes-off, so they never pay for the correlated cascade that trips the
streak brake and parks the engine for a night.

What the refusals do show is the mechanism, uncontaminated. The smaller
was a rung of a gas-price ladder, worth −$0.30. The larger was this:

    KXARGNACBGAME-26AUG22FCOABO-TIE   49c → 32c   −$4.06  stop-loss
    KXARGNACBGAME-26AUG22FCOABO-FCO   73c → 21c   −$7.10  stop-loss

One football match. The engine stopped out of the draw, then five
minutes later bought the home side — the other side of the same ninety
minutes, on the same disproof, for the second-largest single loss in
the run. The two could not both have paid. That is the 1.10.0 cascade
exactly, on a series the 1.10.0 rule could not see.

## A regression the fix nearly shipped

The Signals page explains every refusal, and the lockout message chose
between "you lost here" and "your ladder lost next door" by testing
whether a ticker equalled its own event key — true, under the old rule,
exactly when a market had no siblings. Under the last-dash rule every
real ticker differs from its event key, so that test would have blamed
an imaginary sibling for **every ordinary stop-out**. The lock now
carries the ticker that lost.

It was caught by reading the call sites, not by the tests, which is the
wrong order — the same order of mistake this document keeps recording.
Restoring the old test with the new grouping fails two playtests with
the wrong message quoted back, so it is pinned now.

## And the number sitting beside the correction

`computeMetrics` counted streaks per trade twenty-four lines above the
comment explaining that a ladder is one unit of evidence. So the History
page's "Streaks" card reported 1.10.0's soak — five take-profits riding
one BTC hour, then four stop-losses when it pulled back — as **5W/4L**,
which is one market changing its mind wearing nine coats. Streaks now
count consecutive *ladders*: a run of same-event trades on the same side
of zero counts once, while distinct ladders in a row still count
separately, because four losses across four ladders really are four
pieces of evidence.

Measured over the recordings, the correction is worth nothing at the
shipped default and a great deal without it:

| | trades / ladders | per trade | per ladder |
| --- | --- | --- | --- |
| live log, cap 1 | 116 / 82 | 5W 6L | 5W 6L |
| live log, cap off | 194 / 63 | 15W 13L | **5W 7L** |
| archive, cap 1 | 154 / 108 | 7W 6L | 6W 6L |
| archive, cap off | 268 / 93 | 15W 11L | **5W 7L** |

With the cap on, the streaks were already honest — the cap prevents the
stacking, so consecutive losses were already landing on different
ladders. The same is true of the recorded live history: 44 trades across
33 ladders, 4W/4L either way. The old count only lies where ladders
stack, which is exactly the condition 1.10.0 identified and exactly the
condition `maxPositionsPerEvent` is adjustable back into — Settings
allows up to 50, and the Backtest page's cap-off comparison row runs at
99. There the old number reported a fifteen-trade winning streak that
was five ladders, and a thirteen-trade losing streak that was seven.

## The brake had the same arithmetic, and it was not a display bug

The losing-streak brake counted rows too, and there it is not a number on
a page — it is the thing that parks the engine. This was the one change
in the whole sequence that would make a safety feature fire *less*
readily, so it got measured before it got written. At the shipped limit
of four:

| | trades | halts by row | by ladder |
| --- | --- | --- | --- |
| live log, cap 1 | 116 | 4 | 4 |
| live log, cap off | 194 | 14 | 6 |
| archive, cap 1 | 154 | 7 | 6 |
| archive, cap off | 268 | 16 | 9 |

**At the shipped default it changes nothing** — four halts either way on
the live recording, six against seven on the archive. The cap already
prevents the stacking that produced the miscount. Where the cap is
raised, more than half the halts were one market move: fourteen becomes
six.

That is the argument for making the change rather than against it. This
brake asks a question about evidence — its own comment says a losing run
means "the market changed shape or the settings are wrong" — and four
rungs of one ladder stopping together is one market disagreeing once.
1.10.0 watched precisely that park the engine for a night on a single BTC
pullback. The money side is untouched and deliberately so: the daily-loss
limit and the drawdown brake still count every dollar of a cascade, which
is the right place to count dollars. `blockedByBrakes` counts the same
way, through the same helper, so Start and the first scan cannot disagree
about whether the engine may run.

## Watching it work on a live book

Everything above is replay, and the research scripts all run brakes-off,
so the harness is structurally blind to half of this. The rules had also
never been *seen* refusing a real entry: in a short live run the price
band and the spread limit reject the siblings long before the cap is
reached. Relaxing only the entry filters — the cap left at its shipped
default of one — and pointing the real engine at Kalshi in dry-run for
five minutes settled it. Nine distinct tickers refused by the cap, across
KXBTC, KXBTCD, KXETHD and four 15-minute series:

    [CAP ] KXBTC-26AUG2905-B77550    already holding a position on this
                                     ladder — sibling strikes are the same bet

and at the end of five minutes of real books, **no ladder held more than
once** — which is the invariant the cap exists to maintain, observed
rather than argued.

More useful still, both halves of the lockout message fired on real
tickers, fifteen distinct ones each:

    [LOCK] KXETH-26AUG2905-B2437     locked out for 60m after losing here
    [LOCK] KXBTC-26AUG2905-B77450    its ladder stopped out — locked for
                                     60m after losing there

The first of those is the regression this release nearly shipped, caught
in the wild rather than in a test. Before the lock started carrying the
ticker that lost, all fifteen of those markets would have been told a
sibling stopped out — for a loss each of them took on its own line.
=======
# The order book: a real signal, and still not money

Depth was the last free input Kalshi publishes that this app had never stored.
It cannot be backfilled — a resolved book is gone — so 1.14.0 started recording
it blind, before the study that reads it existed. Twenty-four hours later there
were 79,772 snapshots across 2,334 markets, and `scripts/book.js` ran two tests
against them.

## The tick test found something, and this is the first time

Does book imbalance predict the next minute's mid? On 74,820 snapshots across
**845 independent events**:

```
  asks stacked   -0.31c   [-0.47, -0.16]
  ask lean       -0.24c   [-0.44, -0.02]
  balanced       +0.04c   [-0.10, +0.19]
  bid lean       +0.46c   [+0.25, +0.69]
  bids stacked   +0.39c   [+0.23, +0.56]
```

That column is monotone through the middle, it is centred almost exactly on zero
where the book is balanced, and the tails do not overlap: bid-heavy books moved
+0.42c against ask-heavy at −0.28c, a spread of **0.70c** with clustered
intervals that stay apart.

After seven strategies and four inputs, that is the first thing in this project
that is a real, statistically clean, event-clustered signal. Resting orders do
carry information about where the price goes next.

## And it is four times too small to touch

Crossing the spread and paying the fee costs roughly three cents. The signal is
seven tenths of one. So the honest reading of the tick test was never "we found
an edge" — it was "we have now bounded the edge, and the bound is below the
cost".

The settlement test confirms it empirically rather than by argument. On 1,875
markets across 373 events the residual does not rise with bid pressure at all
(1.8, 4.7, 1.9, 5.7, 1.0 pp, every interval straddling zero), and following the
book loses at every threshold with intervals that exclude zero on the LOSING
side:

```
  |imb| >= 0.15   -6.10c   [-8.96, -3.46]
  |imb| >= 0.30   -6.59c   [-9.87, -3.42]
  |imb| >= 0.50   -7.49c   [-11.07, -3.85]
  |imb| >= 0.70   -9.77c   [-14.18, -5.55]
```

Reliably negative, and more negative the harder you lean on the signal — which
is exactly the shape of a real predictor being eaten by a fixed cost. The
stronger the imbalance, the more certain the trade, the more spread you pay to
get it.

## Why the two-test design earned itself

The tick test needs only quotes and depth, so it produced a readable answer
within an hour of the recorder starting; the settlement test needed markets to
close and took a day. Running the cheap one first bounded the effect at about a
cent while there was still time to abandon the expensive one.

It did not need abandoning, but the principle held: the tick test predicted the
settlement result before the settlement data existed, and the settlement result
arrived agreeing with it.

## Where that leaves the search

Eight studies, eight negatives, and the free inputs are exhausted — quotes,
settlements, spot, the tape, and now the order book. The last of them found a
genuine signal and measured it as unreachable, which is a better ending than
another shrug.

Both sides of the trade stay closed for the reasons already measured: as taker
the spread plus the fee exceeds the mispricing in every band, and as maker the
fee is genuinely zero but resting orders eat −12.4pp of adverse selection. A
one-cent predictive signal does not rescue either.

## Caveat, standing

Stronger, and more specific than before. There is now a measured signal in this
market and a measured reason it cannot be traded at this resolution. Nothing
here has a demonstrated forward edge, and the Evidence page will say so on your
own recording.
