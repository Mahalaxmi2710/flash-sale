import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';

/**
 * Loads the session and sale info once, and measures the offset between the server clock and this
 * device's clock so the countdown is accurate even if the device clock is wrong.
 * No polling: 100k clients polling this endpoint would itself be a load problem.
 */
export function useSale() {
  const [state, setState] = useState({ phase: 'loading', sale: null, offsetMs: 0, error: null });

  const load = useCallback(async () => {
    setState({ phase: 'loading', sale: null, offsetMs: 0, error: null });
    try {
      await api.createSession();
      const sentAt = Date.now();
      const sale = await api.getSale();
      const receivedAt = Date.now();
      const offsetMs = sale.serverTime - (sentAt + (receivedAt - sentAt) / 2);
      setState({ phase: 'ready', sale, offsetMs, error: null });
    } catch (error) {
      setState({ phase: 'error', sale: null, offsetMs: 0, error });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
}