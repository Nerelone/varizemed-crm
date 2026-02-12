import { api } from "../../shared/api/client";

export type ConversationStatus = "bot" | "pending_handoff" | "claimed" | "active" | "resolved" | string;

export type Conversation = {
  conversation_id: string;
  status: ConversationStatus;
  assignee?: string | null;
  assignee_name?: string | null;
  user_name?: string | null;
  wa_profile_name?: string | null;
  tags?: string[] | null;
  last_message_text?: string | null;
  updated_at?: string | null;
};

export type ListConversationsResponse = {
  items: Conversation[];
  next_cursor?: string;
};

export type ReopenBatchScope = "all" | "bot" | "active" | "staging_test";

export type ReopenBatchCapabilities = {
  is_staging: boolean;
  has_staging_test_scope: boolean;
  test_phone_count: number;
  scopes: Array<{ id: ReopenBatchScope; label: string }>;
};

export type ReopenBatchResponse = {
  success: boolean;
  preview: boolean;
  scope: ReopenBatchScope | string;
  is_staging: boolean;
  reopened_count?: number;
  eligible_count?: number;
  skipped_recent: number;
  skipped_window_open: number;
  skipped_not_allowed: number;
  checked: number;
  sample_count?: number;
  sample_conversations?: Array<{
    conversation_id: string;
    status: string;
    updated_at?: string | null;
    last_message_text?: string;
  }>;
  errors?: Array<{ conversation_id: string; error: { code?: string; message?: string } }>;
};

export async function listConversations(params: {
  status: string;
  limit?: number;
  cursor?: string | null;
  mine?: boolean;
}) {
  const search = new URLSearchParams();
  search.set("status", params.status);
  search.set("limit", String(params.limit ?? 50));
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.mine) search.set("mine", "true");
  return api<ListConversationsResponse>(`/api/admin/conversations?${search.toString()}`);
}

export async function getConversation(conversationId: string) {
  return api<Conversation>(`/api/admin/conversations/${encodeURIComponent(conversationId)}`);
}

export async function searchConversations(params: { query: string; limit?: number }) {
  const search = new URLSearchParams();
  search.set("q", params.query);
  search.set("limit", String(params.limit ?? 50));
  return api<ListConversationsResponse>(`/api/admin/conversations/search?${search.toString()}`);
}

export async function claimConversation(conversationId: string) {
  return api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/claim`, { method: "POST" });
}

export async function handoffConversation(conversationId: string) {
  return api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/handoff`, { method: "POST" });
}

export async function takeoverConversation(conversationId: string) {
  return api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/takeover`, { method: "POST" });
}

export async function resolveConversation(conversationId: string) {
  return api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/resolve`, { method: "POST" });
}

export async function reopenConversation(conversationId: string) {
  return api<{ old_status: string; new_status: string }>(
    `/api/admin/conversations/${encodeURIComponent(conversationId)}/reopen`,
    { method: "POST" }
  );
}

export async function updateUserName(conversationId: string, userName: string) {
  return api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/user-name`, {
    method: "POST",
    body: { user_name: userName }
  });
}

export async function updateConversationTags(conversationId: string, tags: string[]) {
  return api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/tags`, {
    method: "POST",
    body: { tags }
  });
}

export async function getReopenBatchCapabilities() {
  return api<ReopenBatchCapabilities>(`/api/admin/reopen-outdated-conversations/capabilities`);
}

export async function reopenOutdatedConversations(params?: { scope?: ReopenBatchScope; preview?: boolean }) {
  return api<ReopenBatchResponse>(`/api/admin/reopen-outdated-conversations`, {
    method: "POST",
    body: {
      scope: params?.scope ?? "all",
      preview: Boolean(params?.preview),
    }
  });
}
