import { useEffect } from "react";

type Options = {
  containerRef: React.RefObject<HTMLElement>;
  onLoadMore: () => void;
  enabled: boolean;
  direction: "top" | "bottom";
  threshold: number;
  debounceMs: number;
};

export function useInfiniteScroll({
  containerRef,
  onLoadMore,
  enabled,
  direction,
  threshold,
  debounceMs
}: Options) {
  useEffect(() => {
    const element = containerRef.current;
    if (!enabled || !element) return undefined;

    let timeoutId: number | undefined;

    const handler = () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        const { scrollTop, scrollHeight, clientHeight } = element;

        if (direction === "top") {
          if (scrollTop < threshold) onLoadMore();
        } else {
          if (scrollHeight - scrollTop - clientHeight < threshold) onLoadMore();
        }
      }, debounceMs);
    };

    element.addEventListener("scroll", handler);

    return () => {
      element.removeEventListener("scroll", handler);
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [enabled, containerRef, direction, threshold, debounceMs, onLoadMore]);
}
