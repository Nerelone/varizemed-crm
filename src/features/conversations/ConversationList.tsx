import { useRef } from "react";
import { Conversation } from "./conversationsApi";
import { ConversationRow } from "./ConversationRow";
import { useInfiniteScroll } from "../chat/useInfiniteScroll";

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onLoadMore,
  hasMore,
  isLoading,
  emptyLabel
}: {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  isLoading: boolean;
  emptyLabel: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useInfiniteScroll({
    containerRef: listRef,
    onLoadMore,
    enabled: hasMore && !isLoading,
    direction: "bottom",
    threshold: 100,
    debounceMs: 150
  });

  return (
    <div className="list" ref={listRef}>
      {conversations.length === 0 ? (
        <div className="empty-state">{emptyLabel}</div>
      ) : (
        conversations.map((conversation) => (
          <ConversationRow
            key={conversation.conversation_id}
            conversation={conversation}
            selected={conversation.conversation_id === selectedId}
            onSelect={() => onSelect(conversation.conversation_id)}
          />
        ))
      )}
      {isLoading ? (
        <div style={{ textAlign: "center", padding: "12px", color: "var(--muted)", fontSize: 12 }}>
          Carregando mais conversas...
        </div>
      ) : null}
    </div>
  );
}
