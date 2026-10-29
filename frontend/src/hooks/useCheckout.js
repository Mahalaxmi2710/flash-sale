import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { createCheckoutFlow } from '../lib/checkoutFlow.js';

const INITIAL = { phase: 'idle', trackingId: null, orderRef: null, error: null, stalled: false, cooldown: false };

/** React wrapper around the framework-free checkout flow (see lib/checkoutFlow.js). */
export function useCheckout(productId) {
  const [state, setState] = useState(INITIAL);
  const flowRef = useRef(null);

  useEffect(() => {
    // Created inside the effect so React StrictMode's mount/unmount/mount cycle gets a fresh flow.
    const flow = createCheckoutFlow({ api, productId });
    flowRef.current = flow;
    const unsubscribe = flow.subscribe(setState);
    flow.start(); // resumes polling after a page reload
    return () => {
      unsubscribe();
      flow.dispose();
      flowRef.current = null;
    };
  }, [productId]);

  const submit = useCallback(() => flowRef.current?.submit(), []);
  const resume = useCallback(() => flowRef.current?.resume(), []);
  return { ...state, submit, resume };
}
