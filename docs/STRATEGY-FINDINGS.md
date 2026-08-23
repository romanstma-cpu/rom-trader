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
