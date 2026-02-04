import { api } from "../../shared/api/client";
import type { MediaAttachment } from "../../shared/utils/mediaUrl";

export type MessageDirection = "in" | "out" | string;

export type Message = {
  message_id?: string;
  client_request_id?: string;
  text?: string;
  direction?: MessageDirection;
  ts?: string;
  display_name?: string;
  media?: MediaAttachment[];
  media_urls?: string[];
  media_url?: string;
  media_type?: string;
  mime?: string;
  content_type?: string;
  url?: string;
};

export type MessagesResponse = {
  items: Message[];
  next_cursor?: string;
};

export async function fetchMessages(conversationId: string, options?: { limit?: number; cursor?: string | null }) {
  const params = new URLSearchParams();
  params.set("limit", String(options?.limit ?? 50));
  if (options?.cursor) params.set("cursor", options.cursor);
  return api<MessagesResponse>(
    `/api/admin/conversations/${encodeURIComponent(conversationId)}/messages?${params.toString()}`
  );
}

export async function sendMessage(conversationId: string, payload: { text: string; client_request_id: string }) {
  return api<{ message?: Message }>(
    `/api/admin/conversations/${encodeURIComponent(conversationId)}/send`,
    {
      method: "POST",
      body: payload
    }
  );
}

export async function checkWindowStatus(conversationId: string) {
  return api<{ outside_24h_window: boolean }>(
    `/api/admin/conversations/${encodeURIComponent(conversationId)}/window-status`
  );
}
