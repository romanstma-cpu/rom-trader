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
