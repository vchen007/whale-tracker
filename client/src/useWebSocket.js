import { useEffect, useRef, useCallback, useState } from 'react';

const WS_URL          = 'ws://localhost:3001/ws';
const REST_URL        = 'http://localhost:3001/trades';
const RECONNECT_DELAY_MS  = 3_000;
const AUTO_REFRESH_MS     = 60_000; // re-fetch history every 60 seconds
const MAX_TRADES = 50_000;

export function useWebSocket(minNotional = 0, sortBy = 'time', limit = 10_000) {
  const [trades, setTrades]       = useState([]);
  const [status, setStatus]       = useState('connecting…');
  const [connected, setConnected] = useState(false);
  const wsRef       = useRef(null);
  const destroyedRef = useRef(false);

  const [refreshing, setRefreshing] = useState(false);
  const minNotionalRef = useRef(minNotional);
  minNotionalRef.current = minNotional;

  const sortByRef  = useRef(sortBy);
  const limitRef   = useRef(limit);
  sortByRef.current = sortBy;
  limitRef.current  = limit;

  const fetchHistory = useCallback(() => {
    setRefreshing(true);
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fetch(`${REST_URL}?since=${since}&minNotional=${minNotionalRef.current}&sortBy=${sortByRef.current}&limit=${limitRef.current}`)
      .then((r) => r.json())
      .then((history) => setTrades(history))
      .catch(() => {})
      .finally(() => setRefreshing(false));
  }, []);

  // Re-fetch history whenever key params change (debounced)
  useEffect(() => {
    const timer = setTimeout(fetchHistory, 400);
    return () => clearTimeout(timer);
  }, [minNotional, sortBy, limit, fetchHistory]);

  // Auto-refresh history on an interval
  useEffect(() => {
    const interval = setInterval(fetchHistory, AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchHistory]);

  const connect = useCallback(() => {
    if (destroyedRef.current) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      if (msg.type === 'status') {
        setStatus(msg.data);
      } else if (msg.type === 'trade') {
        setTrades((prev) => {
          const next = [msg.data, ...prev];
          return next.length > MAX_TRADES ? next.slice(0, MAX_TRADES) : next;
        });
      }
    };

    ws.onerror = () => setConnected(false);

    ws.onclose = () => {
      setConnected(false);
      setStatus('disconnected – reconnecting…');
      if (!destroyedRef.current) setTimeout(connect, RECONNECT_DELAY_MS);
    };
  }, []);

  useEffect(() => {
    destroyedRef.current = false;
    connect();
    return () => {
      destroyedRef.current = true;
      wsRef.current?.close();
    };
  }, [connect]);

  return { trades, status, connected, refresh: fetchHistory, refreshing };
}
