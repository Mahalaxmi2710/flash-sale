import { useEffect, useState } from 'react';

/** Server-corrected "now", ticking every 250 ms until stopAt, then idle (no needless re-renders). */
export function useServerNow(offsetMs, stopAt) {
  const [now, setNow] = useState(() => Date.now() + offsetMs);

  useEffect(() => {
    setNow(Date.now() + offsetMs);
    if (stopAt != null && Date.now() + offsetMs >= stopAt) return undefined;
    const id = setInterval(() => {
      const current = Date.now() + offsetMs;
      setNow(current);
      if (stopAt != null && current >= stopAt) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [offsetMs, stopAt]);

  return now;
}