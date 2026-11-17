import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

export function usePolling(path, intervalMs = 5000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api.get(path));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [path]);

  useEffect(() => {
    load();
    if (!intervalMs) return undefined;
    const t = setInterval(load, intervalMs);
    return () => clearInterval(t);
  }, [load, intervalMs]);

  return { data, error, reload: load };
}
