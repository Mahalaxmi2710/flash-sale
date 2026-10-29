export default function CheckoutButton({ label, disabled, busy, onClick }) {
  return (
    <button type="button" className="buy" disabled={disabled} aria-busy={busy} onClick={onClick}>
      {busy && <span className="spinner" aria-hidden="true" />}
      {label}
    </button>
  );
}