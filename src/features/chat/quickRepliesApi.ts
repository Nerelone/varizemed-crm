import { api } from "../../shared/api/client";

export type QuickReply = {
  id: string;
  title: string;
  text: string;
  shortcut?: string;
};

export async function listQuickReplies() {
  return api<{ items: QuickReply[] }>(`/api/user/quick-replies`);
}

export async function createQuickReply(payload: { title: string; text: string; shortcut?: string }) {
  return api<QuickReply>(`/api/user/quick-replies`, {
    method: "POST",
    body: payload
  });
}

export async function updateQuickReply(
  replyId: string,
  payload: { title: string; text: string; shortcut?: string }
) {
  return api<{ ok: boolean; id: string }>(`/api/user/quick-replies/${encodeURIComponent(replyId)}`, {
    method: "PUT",
    body: payload
  });
}

export async function deleteQuickReply(replyId: string) {
  return api<{ ok: boolean }>(`/api/user/quick-replies/${encodeURIComponent(replyId)}`, {
    method: "DELETE"
  });
}
