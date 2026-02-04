import { formatRelativeTime } from "../../shared/utils/time";
import { Message } from "./chatApi";
import { MediaAttachment } from "./MediaAttachment";

export function MessageBubble({
  message,
  isOutgoing,
  outgoingName,
  conversationId
}: {
  message: Message;
  isOutgoing: boolean;
  outgoingName: string;
  conversationId: string;
}) {
  const displayName = message.display_name || (isOutgoing ? outgoingName : "Cliente");
  const meta = `${displayName}  ${formatRelativeTime(message.ts)}`;

  return (
    <div style={{ display: "flex", justifyContent: isOutgoing ? "flex-end" : "flex-start" }}>
      <div className={`bubble ${isOutgoing ? "me" : "other"}`}>
        {message.text || ""}
        <div className="meta">{meta}</div>
        <MediaAttachment message={message} conversationId={conversationId} />
      </div>
    </div>
  );
}
