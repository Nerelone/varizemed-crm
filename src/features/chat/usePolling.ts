import { useEffect, useRef } from "react";

export function usePolling(
  callback: () => void | Promise<void>,
  intervalMs: number,
  enabled: boolean
) {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return undefined;

    let canceled = false;
    const tick = async () => {
      if (canceled) return;
      await savedCallback.current();
    };

    const id = window.setInterval(tick, intervalMs);

    return () => {
      canceled = true;
      window.clearInterval(id);
    };
  }, [intervalMs, enabled]);
}
