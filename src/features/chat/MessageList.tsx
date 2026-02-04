import { useEffect, useRef, useState } from "react";
import { Message } from "./chatApi";
import { MessageBubble } from "./MessageBubble";
import { useInfiniteScroll } from "./useInfiniteScroll";
import { Loading } from "../../shared/ui/Loading";

export function MessageList({
  messages,
  listRef,
  onLoadMore,
  hasMore,
  isLoadingMore,
  conversationId,
  outgoingName
}: {
  messages: Message[];
  listRef: React.RefObject<HTMLDivElement>;
  onLoadMore: () => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  conversationId: string;
  outgoingName: string;
}) {
  const [showNewIndicator, setShowNewIndicator] = useState(false);
  const prevCount = useRef(0);

  useInfiniteScroll({
    containerRef: listRef,
    onLoadMore,
    enabled: hasMore && !isLoadingMore,
    direction: "top",
    threshold: 100,
    debounceMs: 150
  });

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;

    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 20;
    const nearTop = element.scrollTop < 120;
    if (messages.length > prevCount.current && !atBottom && !nearTop) {
      setShowNewIndicator(true);
    }
    if (atBottom) {
      setShowNewIndicator(false);
    }

    prevCount.current = messages.length;
  }, [messages, listRef]);

  return (
    <>
      <div className="chat-body" ref={listRef}>
        {isLoadingMore ? <Loading label="Carregando mensagens antigas..." /> : null}
        {messages.map((message) => (
          <MessageBubble
            key={message.message_id || `${message.ts}-${message.direction}`}
            message={message}
            isOutgoing={message.direction === "out"}
            outgoingName={outgoingName}
            conversationId={conversationId}
          />
        ))}
      </div>
      {showNewIndicator ? (
        <div
          style={{
            position: "fixed",
            bottom: 80,
            right: "50%",
            transform: "translateX(50%)",
            background: "var(--acc)",
            color: "#06210f",
            padding: "8px 16px",
            borderRadius: 20,
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            zIndex: 1000,
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)"
          }}
          onClick={() => {
            const element = listRef.current;
            if (element) {
              element.scrollTop = element.scrollHeight;
            }
            setShowNewIndicator(false);
          }}
        >
          Nova mensagem
        </div>
      ) : null}
    </>
  );
}
