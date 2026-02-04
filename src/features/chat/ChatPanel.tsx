import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../../shared/ui/Toast";
import { useAuth } from "../auth/authStore";
import {
  claimConversation,
  handoffConversation,
  resolveConversation,
  reopenConversation,
  updateUserName,
  Conversation
} from "../conversations/conversationsApi";
import { useConversationsStore } from "../conversations/conversationsStore";
import { checkWindowStatus, sendMessage } from "./chatApi";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { useMessages } from "./useMessages";
import { usePolling } from "./usePolling";

function usePageVisibility() {
  const [isVisible, setIsVisible] = useState(!document.hidden);

  useEffect(() => {
    const handler = () => setIsVisible(!document.hidden);
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  return isVisible;
}

function showDesktopNotification(title: string, body: string) {
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const notification = new Notification(title, {
        body,
        icon: "/favicon.ico",
        badge: "/favicon.ico",
        tag: "crm-notification",
        requireInteraction: false
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
      window.setTimeout(() => notification.close(), 5000);
    } catch (error) {
      console.warn("Erro ao notificar:", error);
    }
  }
}

function messageKey(message: { message_id?: string; ts?: string; direction?: string; text?: string }) {
  if (message.message_id) return message.message_id;
  const ts = message.ts ? new Date(message.ts).getTime() : 0;
  return `${ts}|${message.direction || ""}|${message.text || ""}`;
}

export function ChatPanel({
  conversation,
  selectedUserName,
  onUserNameChange,
  updateConversationInLists
}: {
  conversation: Conversation | null;
  selectedUserName: string;
  onUserNameChange: (name: string) => void;
  updateConversationInLists: (conversationId: string, updates: Partial<Conversation>) => void;
}) {
  const { push } = useToast();
  const { username, displayName } = useAuth();
  const {
    currentTab,
    refreshAll,
    loadTab,
    setCurrentTab,
    selectConversation,
    clearSelection
  } = useConversationsStore();

  const listRef = useRef<HTMLDivElement>(null);
  const { messages, hasMore, isLoadingMore, loadInitial, loadMore, refresh, appendOptimistic, reset } =
    useMessages(conversation?.conversation_id || null, listRef);

  const [messageText, setMessageText] = useState("");
  const [outsideWindow, setOutsideWindow] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [editNameOpen, setEditNameOpen] = useState(false);
  const [editNameValue, setEditNameValue] = useState("");

  const isVisible = usePageVisibility();
  const knownMessageIds = useRef<Set<string>>(new Set());

  const conversationId = conversation?.conversation_id || "";
  const mine = conversation?.assignee === username;
  const status = conversation?.status || "";

  const canResolve = Boolean(
    conversation && ((mine && (status === "claimed" || status === "active")) || status === "bot")
  );
  const canClaim = Boolean(conversation && !mine && status === "pending_handoff");
  const canHandoff = Boolean(conversation && status === "bot");

  const checkWindow = useCallback(async () => {
    if (!conversationId) return;
    try {
      const res = await checkWindowStatus(conversationId);
      setOutsideWindow(res.outside_24h_window);
    } catch (error) {
      console.error("Erro ao verificar janela 24h:", error);
      setOutsideWindow(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) {
      reset();
      setOutsideWindow(false);
      setMessageText("");
      return;
    }

    loadInitial();
    checkWindow();
  }, [conversationId, loadInitial, checkWindow, reset]);

  usePolling(
    async () => {
      if (!conversationId) return;
      await refresh();
    },
    10000,
    Boolean(conversationId)
  );

  useEffect(() => {
    if (!conversationId) {
      knownMessageIds.current = new Set();
      return;
    }

    const nextIds = new Set<string>();
    const newIncoming = [] as typeof messages;

    for (const message of messages) {
      const key = messageKey(message);
      nextIds.add(key);
      if (!knownMessageIds.current.has(key) && message.direction === "in") {
        newIncoming.push(message);
      }
    }

    if (newIncoming.length > 0) {
      if (!isVisible) {
        showDesktopNotification(
          "Nova mensagem!",
          `De ${conversationId}: ${newIncoming[0].text?.substring(0, 50) || "..."}`
        );
      }
      if (outsideWindow) {
        checkWindow();
      }
    }

    knownMessageIds.current = nextIds;
  }, [messages, isVisible, conversationId, outsideWindow, checkWindow]);

  const handleSend = useCallback(async () => {
    if (!conversationId || !messageText.trim() || isSending) return;

    setIsSending(true);
    const rid = (globalThis.crypto && "randomUUID" in globalThis.crypto)
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    try {
      const response = await sendMessage(conversationId, {
        text: messageText.trim(),
        client_request_id: rid
      });
      setMessageText("");

      const outgoing = response.message || {
        message_id: `temp:${rid}`,
        text: messageText.trim(),
        display_name: displayName,
        direction: "out",
        ts: new Date().toISOString()
      };

      appendOptimistic(outgoing);
      await refreshAll();
    } catch (error) {
      push(`Falha ao enviar: ${(error as Error)?.message || "Erro"}`);
    } finally {
      setIsSending(false);
    }
  }, [appendOptimistic, conversationId, displayName, isSending, messageText, push, refreshAll]);

  const handleClaim = useCallback(async () => {
    if (!conversationId) return;
    try {
      await claimConversation(conversationId);
      push(`Conversa assumida: ${conversationId}`);
      await refreshAll();
      await selectConversation(conversationId);
    } catch (error) {
      push(`Erro ao assumir: ${(error as Error)?.message || "Erro"}`);
    }
  }, [conversationId, push, refreshAll, selectConversation]);

  const handleHandoff = useCallback(async () => {
    if (!conversationId) return;
    try {
      await handoffConversation(conversationId);
      push(`Conversa assumida do bot: ${conversationId}`);
      await refreshAll();
      await selectConversation(conversationId);
    } catch (error) {
      push(`Erro ao assumir do bot: ${(error as Error)?.message || "Erro"}`);
    }
  }, [conversationId, push, refreshAll, selectConversation]);

  const handleResolve = useCallback(async () => {
    if (!conversationId) return;
    try {
      await resolveConversation(conversationId);
      push(`Encerrada: ${conversationId}`);
      await refreshAll();
      clearSelection();
      reset();
    } catch (error) {
      push(`Erro ao encerrar: ${(error as Error)?.message || "Erro"}`);
    }
  }, [conversationId, push, refreshAll, clearSelection, reset]);

  const handleReopen = useCallback(async () => {
    if (!conversationId || isSending) return;

    const confirmMsg = currentTab === "resolved"
      ? "Reabrir esta conversa? Um template será enviado ao cliente e a conversa será movida para suas conversas ativas."
      : "Reabrir esta conversa? Um template será enviado ao cliente.";

    if (!confirm(confirmMsg)) return;

    setIsSending(true);
    try {
      const resp = await reopenConversation(conversationId);
      if (resp.old_status !== resp.new_status) {
        push(`Conversa reaberta e movida de ${resp.old_status} → ${resp.new_status}`);

        if (resp.old_status === "resolved") {
          await loadTab("resolved");
          await loadTab("claimed");
          setCurrentTab("claimed");
        } else if (resp.old_status === "pending_handoff") {
          await loadTab("pending");
          await loadTab("claimed");
          setCurrentTab("claimed");
        }
      } else {
        push("Conversa reaberta com sucesso!");
      }

      setOutsideWindow(false);
      await refresh();
      await selectConversation(conversationId);
    } catch (error) {
      push(`Erro ao reabrir conversa: ${(error as Error)?.message || "Erro"}`);
    } finally {
      setIsSending(false);
    }
  }, [conversationId, currentTab, isSending, loadTab, push, refresh, selectConversation, setCurrentTab]);

  const handleEditNameSave = useCallback(async () => {
    if (!conversationId) return;
    const newName = editNameValue.trim();
    if (!newName) {
      push("Digite um nome para o cliente");
      return;
    }
    if (newName.length > 100) {
      push("Nome muito longo (max 100 caracteres)");
      return;
    }

    try {
      await updateUserName(conversationId, newName);
      onUserNameChange(newName);
      updateConversationInLists(conversationId, { user_name: newName });
      await selectConversation(conversationId);
      setEditNameOpen(false);
      push("Nome salvo com sucesso!");
    } catch (error) {
      push(`Erro ao salvar nome: ${(error as Error)?.message || "Erro"}`);
    }
  }, [conversationId, editNameValue, onUserNameChange, push, selectConversation, updateConversationInLists]);

  const windowNoticeText = status === "resolved"
    ? {
        title: "Conversa encerrada - Janela de 24h expirada",
        body: "Esta conversa foi encerrada e está inativa há mais de 24 horas. Para retomar o contato, clique em \"Reabrir Conversa\" e ela será automaticamente assumida por você."
      }
    : {
        title: "Janela de 24h expirada",
        body: "Esta conversa está inativa há mais de 24 horas. Para enviar novas mensagens, você precisa reabrir a conversa primeiro."
      };

  return (
    <>
      <div className="chat-header">
        <div style={{ fontWeight: 600 }}>Conversa:</div>
        <div className="chat-contact-info">
          {selectedUserName ? (
            <span className="customer-name">{selectedUserName}</span>
          ) : null}
          <span className="phone-number">{conversationId}</span>
          <button
            className="btn-edit-name"
            onClick={() => {
              if (!conversationId) return;
              setEditNameValue(selectedUserName || "");
              setEditNameOpen(true);
            }}
            title={selectedUserName ? "Editar nome" : "Adicionar nome"}
            disabled={!conversationId}
          >
            {selectedUserName ? "✏️" : "➕"}
          </button>
        </div>
        <div className="spacer"></div>
        {canClaim ? (
          <button className="btn btn-warn" onClick={handleClaim}>
            Assumir
          </button>
        ) : null}
        {canHandoff ? (
          <button className="btn btn-acc" onClick={handleHandoff}>
            🤖 Assumir do Bot
          </button>
        ) : null}
        {canResolve ? (
          <button className="btn btn-danger" onClick={handleResolve}>
            Encerrar
          </button>
        ) : null}
      </div>

      {conversationId ? (
        <MessageList
          messages={messages}
          listRef={listRef}
          onLoadMore={loadMore}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          conversationId={conversationId}
          outgoingName={displayName || ""}
        />
      ) : (
        <div className="chat-body">
          <div className="empty-state">Selecione uma conversa</div>
        </div>
      )}

      {outsideWindow ? (
        <div className="window-closed-notice">
          <div className="notice-icon">🔒</div>
          <div className="notice-content">
            <strong>{windowNoticeText.title}</strong>
            <p>{windowNoticeText.body}</p>
          </div>
        </div>
      ) : null}

      <Composer
        value={messageText}
        onChange={setMessageText}
        onSend={handleSend}
        onReopen={handleReopen}
        showReopen={outsideWindow}
        disabled={!conversationId || isSending}
      />

      <div className={`overlay ${editNameOpen ? "show" : ""}`}>
        <div className="modal">
          <h3 style={{ margin: "0 0 12px 0" }}>Nome do Cliente</h3>
          <div className="grid">
            <label>Digite o nome do cliente</label>
            <input
              type="text"
              value={editNameValue}
              onChange={(event) => setEditNameValue(event.target.value)}
              placeholder="Ex: Maria Silva, João, Dr. Carlos"
              maxLength={100}
            />
            <small style={{ color: "var(--muted)", fontSize: 11, marginTop: -8 }}>
              Este nome será exibido no lugar do número de telefone
            </small>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn" onClick={() => setEditNameOpen(false)} style={{ flex: 1 }}>
                Cancelar
              </button>
              <button className="btn btn-acc" onClick={handleEditNameSave} style={{ flex: 1 }}>
                Salvar
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
