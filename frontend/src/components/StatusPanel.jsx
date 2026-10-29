export default function StatusPanel({ checkout }) {
  const { phase, trackingId, orderRef, error, stalled, resume } = checkout;
  if (phase === 'idle') return null;

  const reference = trackingId && (
    <p className="muted">
      Reference: <code>{trackingId}</code>
    </p>
  );

  return (
    <div className={`status status-${phase}`} role="status" aria-live="polite">
      {phase === 'submitting' && <p>Securing your unit&hellip; please don&apos;t close this page.</p>}

      {phase === 'queued' && (
        <>
          <p className="status-title">You&apos;re in the queue</p>
          <p>Your unit is reserved and your order is waiting to be processed.</p>
          {reference}
        </>
      )}

      {phase === 'processing' && (
        <>
          <p className="status-title">Processing your order&hellip;</p>
          <p>Almost there. This page updates by itself.</p>
          {reference}
        </>
      )}

      {phase === 'confirmed' && (
        <>
          <p className="status-title">Order confirmed!</p>
          <p>Your Phoenix X is yours. Keep this reference:</p>
          <code>{orderRef ?? trackingId}</code>
        </>
      )}

      {phase === 'soldOut' && (
        <>
          <p className="status-title">Sold out</p>
          <p>All 500 units have been claimed. Thanks for trying!</p>
        </>
      )}

      {phase === 'failure' && (
        <>
          <p className="status-title">That didn&apos;t go through</p>
          <p>{error?.message}</p>
        </>
      )}

      {stalled && (
        <>
          <p>This is taking longer than usual. Your order is safe; we will keep it.</p>
          <button type="button" className="secondary" onClick={resume}>
            Check again
          </button>
        </>
      )}
    </div>
  );
}
