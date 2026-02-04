import { Conversation } from "./conversationsApi";
import { formatRelativeTime } from "../../shared/utils/time";

function getStatusLabel(status: string) {
  const labels: Record<string, string> = {
    bot: "Val",
    claimed: "Humano",
    active: "Humano",
    pending_handoff: "Fila",
    resolved: "Resolvido"
  };
  return labels[status] || status;
}

function getAvatarInitials(phone: string) {
  const digits = phone.replace(/\D/g, "");
  return digits.slice(-4, -2) || "??";
}

function getAvatarColor(phone: string) {
  let hash = 0;
  for (let i = 0; i < phone.length; i += 1) {
    hash = phone.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
    "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)",
    "linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)",
    "linear-gradient(135deg, #fa709a 0%, #fee140 100%)",
    "linear-gradient(135deg, #30cfd0 0%, #330867 100%)",
    "linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)",
    "linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)"
  ];
  return colors[Math.abs(hash) % colors.length];
}

export function ConversationRow({
  conversation,
  selected,
  onSelect
}: {
  conversation: Conversation;
  selected: boolean;
  onSelect: () => void;
}) {
  const statusClass = conversation.status === "pending_handoff" ? "pending" : conversation.status;
  const initials = getAvatarInitials(conversation.conversation_id);
  const avatarBg = getAvatarColor(conversation.conversation_id);
  const displayName = conversation.user_name || conversation.conversation_id;
  const showSecondary = Boolean(conversation.user_name);

  return (
    <div className={`conv-item ${selected ? "selected" : ""}`} onClick={onSelect}>
      <div className="avatar" style={{ background: avatarBg }}>
        {initials}
      </div>
      <div className="conv-content">
        <div className="conv-header">
          <span className="conv-phone">{displayName}</span>
          <span className={`conv-status ${statusClass}`}>{getStatusLabel(conversation.status)}</span>
        </div>
        {showSecondary ? (
          <span className="conv-phone-secondary">{conversation.conversation_id}</span>
        ) : null}
        <div className="conv-preview">{conversation.last_message_text || "Sem mensagens"}</div>
        <div className="conv-time">{formatRelativeTime(conversation.updated_at)}</div>
      </div>
    </div>
  );
}
