import appIcon from "../../assets/icon-256.png";

export default function Welcome({ onAccept }: { onAccept: () => void }) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <img src={appIcon} alt="" className="welcome-icon" />
        <h1>ROM Trader</h1>
        <p className="welcome-lead">
          An automated momentum bot for Kalshi prediction markets. Read this once before you start.
        </p>

        <ul className="welcome-points">
          <li>
            <strong>It starts in dry-run.</strong> Out of the box it paper-trades against live
            prices and places no real orders. Live mode is off until you add API keys and switch it
            on yourself.
          </li>
          <li>
            <strong>The strategy is a simple heuristic, not an edge.</strong> It buys YES when the
            mid-price has risen a few cents and exits on a target, a stop, or a reversal. It has no
            demonstrated profitability, and fees and spread work against it.
          </li>
          <li>
            <strong>You can lose money in live mode.</strong> Only ever risk an amount you are
            fully prepared to lose, and set a daily loss limit in Settings.
          </li>
          <li>
            <strong>Everything stays on this PC.</strong> Keys, settings and trade history live in
            a local folder. Nothing is uploaded and there is no account.
          </li>
        </ul>

        <p className="welcome-fine">
          ROM Trader is provided as-is with no warranty. It is not financial advice, and its author
          is not a licensed advisor. You are responsible for every order it places on your behalf.
        </p>

        <button className="btn primary big" onClick={onAccept}>
          I understand — open the app
        </button>
      </div>
    </div>
  );
}
