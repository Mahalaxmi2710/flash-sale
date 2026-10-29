function split(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

const pad = (n) => String(n).padStart(2, '0');

export default function Countdown({ remainingMs }) {
  const { days, hours, minutes, seconds } = split(remainingMs);
  const label = `Sale starts in ${days} days ${hours} hours ${minutes} minutes ${seconds} seconds`;
  return (
    <div className="countdown" role="timer" aria-label={label}>
      <p className="muted">Sale starts in</p>
      <div className="countdown-cells" aria-hidden="true">
        {days > 0 && (
          <div>
            <strong>{days}</strong>
            <span>days</span>
          </div>
        )}
        <div>
          <strong>{pad(hours)}</strong>
          <span>hrs</span>
        </div>
        <div>
          <strong>{pad(minutes)}</strong>
          <span>min</span>
        </div>
        <div>
          <strong>{pad(seconds)}</strong>
          <span>sec</span>
        </div>
      </div>
    </div>
  );
}