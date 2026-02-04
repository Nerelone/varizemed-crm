export function formatRelativeTime(ts?: string | null) {
  if (!ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const diff = now.getTime() - date.getTime();

  if (diff < 60000) return "agora";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d`;

  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}
