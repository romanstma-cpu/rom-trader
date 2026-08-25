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
