export type MediaAttachment = {
  signed_url?: string | null;
  gcs_url?: string | null;
  url?: string | null;
  content_type?: string | null;
  mime?: string | null;
};

export function getSafeMediaUrl(conversationId: string, messageId: string | undefined, attachment: MediaAttachment) {
  const direct = attachment.gcs_url || attachment.signed_url || attachment.url || "";

  if (direct && !/api\.twilio\.com\/2010-04-01\//.test(direct)) {
    return direct;
  }

  if (messageId && conversationId) {
    return `/api/admin/media/${encodeURIComponent(conversationId)}/${encodeURIComponent(messageId)}`;
  }

  return direct;
}
