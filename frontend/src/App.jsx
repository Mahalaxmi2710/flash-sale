import CheckoutButton from './components/CheckoutButton.jsx';
import Countdown from './components/Countdown.jsx';
import ProductCard from './components/ProductCard.jsx';
import StatusPanel from './components/StatusPanel.jsx';
import { useCheckout } from './hooks/useCheckout.js';
import { useSale } from './hooks/useSale.js';
import { useServerNow } from './hooks/useServerNow.js';

const HAS_ORDER = new Set(['queued', 'processing', 'confirmed']);

function buttonLabel({ started, soldOut, checkout }) {
  if (soldOut) return 'Sold out';
  if (!started) return 'Sale starts soon';
  switch (checkout.phase) {
    case 'submitting':
      return 'Securing your unit…';
    case 'queued':
      return 'In the queue…';
    case 'processing':
      return 'Processing your order…';
    case 'confirmed':
      return 'Order confirmed';
    default:
      return checkout.cooldown ? 'Please wait…' : 'Buy now';
  }
}

function SalePanel({ sale, offsetMs }) {
  const now = useServerNow(offsetMs, sale.startsAt);
  const checkout = useCheckout(sale.product.id);

  const started = now >= sale.startsAt;
  // A buyer who already holds (or is getting) a unit never sees "Sold out" for their own order.
  const soldOut = !HAS_ORDER.has(checkout.phase) && (sale.status === 'SOLD_OUT' || checkout.phase === 'soldOut');
  const busy = ['submitting', 'queued', 'processing'].includes(checkout.phase);
  const disabled = !started || soldOut || busy || checkout.cooldown || checkout.phase === 'confirmed';

  return (
    <section className="card buy-panel">
      {!started && !soldOut && <Countdown remainingMs={sale.startsAt - now} />}
      {started && !soldOut && checkout.phase === 'idle' && <p className="live">The sale is live!</p>}
      <CheckoutButton
        label={buttonLabel({ started, soldOut, checkout })}
        disabled={disabled}
        busy={busy}
        onClick={checkout.submit}
      />
      <StatusPanel checkout={checkout} />
    </section>
  );
}

function LoadingState() {
  return (
    <div className="card" role="status" aria-live="polite">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-line" />
      <div className="skeleton skeleton-button" />
      <p className="muted">Loading the sale&hellip;</p>
    </div>
  );
}

function ErrorState({ error, onRetry }) {
  const message =
    error?.code === 'NETWORK' || error?.code === 'TIMEOUT'
      ? "We can't reach the server right now."
      : error?.message || 'Something went wrong while loading the sale.';
  return (
    <div className="card status status-failure" role="alert">
      <p className="status-title">Couldn&apos;t load the sale</p>
      <p>{message}</p>
      <button type="button" className="secondary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export default function App() {
  const { phase, sale, offsetMs, error, reload } = useSale();

  return (
    <main className="page">
      {phase === 'loading' && <LoadingState />}
      {phase === 'error' && <ErrorState error={error} onRetry={reload} />}
      {phase === 'ready' && (
        <>
          <ProductCard product={sale.product} />
          <SalePanel sale={sale} offsetMs={offsetMs} />
        </>
      )}
      <footer className="muted">500 units &middot; one per customer &middot; first come, first served</footer>
    </main>
  );
}