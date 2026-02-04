import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cmpMsg } from "../../shared/utils/sortMessages";
import { fetchMessages, Message } from "./chatApi";

function messageKey(message: Message) {
  if (message.message_id) return message.message_id;
  const ts = message.ts ? new Date(message.ts).getTime() : 0;
  return `${ts}|${message.direction || ""}|${message.text || ""}`;
}

function mergeMessages(existing: Message[], incoming: Message[]) {
  const byKey = new Map<string, Message>();
  for (const msg of [...existing, ...incoming]) {
    const key = messageKey(msg);
    if (!byKey.has(key)) {
      byKey.set(key, msg);
    }
  }
  return Array.from(byKey.values()).sort(cmpMsg);
}

function applyServerIds(existing: Message[], incoming: Message[]) {
  const idMap = new Map<string, string>();
  incoming.forEach((msg) => {
    if (msg.client_request_id && msg.message_id) {
      idMap.set(`temp:${msg.client_request_id}`, msg.message_id);
    }
  });

  if (idMap.size === 0) return existing;

  return existing.map((msg) => {
    if (msg.message_id && idMap.has(msg.message_id)) {
      return { ...msg, message_id: idMap.get(msg.message_id)! };
    }
    return msg;
  });
}

export function useMessages(conversationId: string | null, listRef: React.RefObject<HTMLDivElement>) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const pendingScrollAdjust = useRef<{ prevScrollTop: number; prevScrollHeight: number } | null>(null);
  const scrollToBottom = useRef(false);

  const reset = useCallback(() => {
    setMessages([]);
    setCursor(null);
    setHasMore(true);
    setIsLoadingMore(false);
    setIsRefreshing(false);
  }, []);

  useEffect(() => {
    reset();
  }, [conversationId, reset]);

  const loadInitial = useCallback(async () => {
    if (!conversationId) return;
    setIsRefreshing(true);
    try {
      const response = await fetchMessages(conversationId, { limit: 50 });
      const sorted = (response.items || []).slice().sort(cmpMsg);
      setMessages(sorted);
      setCursor(response.next_cursor || null);
      setHasMore(Boolean(response.next_cursor));
      scrollToBottom.current = true;
    } finally {
      setIsRefreshing(false);
    }
  }, [conversationId]);

  const loadMore = useCallback(async () => {
    if (!conversationId || !hasMore || isLoadingMore || !cursor) return;

    const element = listRef.current;
    const prevScrollTop = element?.scrollTop ?? 0;
    const prevScrollHeight = element?.scrollHeight ?? 0;

    setIsLoadingMore(true);
    try {
      const response = await fetchMessages(conversationId, { limit: 25, cursor });
      const incoming = response.items || [];
      setMessages((prev) => mergeMessages(prev, incoming));
      setCursor(response.next_cursor || null);
      setHasMore(Boolean(response.next_cursor));
      pendingScrollAdjust.current = { prevScrollTop, prevScrollHeight };
    } finally {
      setIsLoadingMore(false);
    }
  }, [conversationId, cursor, hasMore, isLoadingMore, listRef]);

  const refresh = useCallback(async () => {
    if (!conversationId || isLoadingMore) return;
    setIsRefreshing(true);
    try {
      const response = await fetchMessages(conversationId, { limit: 50 });
      const incoming = response.items || [];
      setMessages((prev) => {
        const withIds = applyServerIds(prev, incoming);
        return mergeMessages(withIds, incoming);
      });
    } finally {
      setIsRefreshing(false);
    }
  }, [conversationId, isLoadingMore]);

  const appendOptimistic = useCallback((message: Message) => {
    setMessages((prev) => mergeMessages(prev, [message]));
    scrollToBottom.current = true;
  }, []);

  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element) return;

    if (pendingScrollAdjust.current) {
      const { prevScrollTop, prevScrollHeight } = pendingScrollAdjust.current;
      const newScrollHeight = element.scrollHeight;
      element.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
      pendingScrollAdjust.current = null;
    }

    if (scrollToBottom.current) {
      element.scrollTop = element.scrollHeight;
      scrollToBottom.current = false;
    }
  }, [messages, listRef]);

  return {
    messages,
    hasMore,
    isLoadingMore,
    isRefreshing,
    loadInitial,
    loadMore,
    refresh,
    appendOptimistic,
    reset
  };
}
