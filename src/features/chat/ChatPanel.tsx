import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../../shared/ui/Toast";
import { useAuth } from "../auth/authStore";
import {
  claimConversation,
  handoffConversation,
  takeoverConversation,
  resolveConversation,
  reopenConversation,
  updateConversationTags,
  updateUserName,
  Conversation
} from "../conversations/conversationsApi";
import { useConversationsStore } from "../conversations/conversationsStore";
import { TAG_OPTIONS, getTagOption } from "../../shared/constants/tags";
import { checkWindowStatus, sendMessage } from "./chatApi";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { useMessages } from "./useMessages";
import { usePolling } from "./usePolling";
import {
  createQuickReply,
  deleteQuickReply,
  listQuickReplies,
  QuickReply,
  updateQuickReply
} from "./quickRepliesApi";

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

function normalizeShortcut(value: string) {
  const raw = value.trim();
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
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

  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [quickRepliesOpen, setQuickRepliesOpen] = useState(false);
  const [quickReplyTitle, setQuickReplyTitle] = useState("");
  const [quickReplyText, setQuickReplyText] = useState("");
  const [quickReplyShortcut, setQuickReplyShortcut] = useState("");
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const [isSavingQuickReply, setIsSavingQuickReply] = useState(false);

  const [tagsOpen, setTagsOpen] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [isSavingTags, setIsSavingTags] = useState(false);

  const isVisible = usePageVisibility();
  const knownMessageIds = useRef<Set<string>>(new Set());

  const conversationId = conversation?.conversation_id || "";
  const mine = conversation?.assignee === username;
  const status = conversation?.status || "";
  const waProfileName = (conversation?.wa_profile_name || "").trim();
  const declaredName = (selectedUserName || "").trim();
  const tagList = Array.isArray(conversation?.tags) ? (conversation?.tags || []) : [];
  const assigneeLabel = (conversation?.assignee_name || conversation?.assignee || "").trim();
  const showAssignee = Boolean(assigneeLabel);
  const tagKey = tagList.join("|");

  const canResolve = Boolean(
    conversation && ((mine && (status === "claimed" || status === "active")) || status === "bot")
  );
  const canClaim = Boolean(conversation && !mine && status === "pending_handoff");
  const canHandoff = Boolean(conversation && status === "bot");
  const canTakeover = Boolean(conversation && !mine && (status === "claimed" || status === "active"));
  const canSend = Boolean(conversationId && mine && (status === "claimed" || status === "active") && !outsideWindow);
  const baseDisabled = !conversationId || isSending;

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

  useEffect(() => {
    if (!conversationId || !conversation?.updated_at) return;
    refresh();
  }, [conversationId, conversation?.updated_at, refresh]);

  useEffect(() => {
    let active = true;
    listQuickReplies()
      .then((res) => {
        if (active) setQuickReplies(res.items || []);
      })
      .catch((error) => {
        console.error("Erro ao carregar respostas rapidas:", error);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setSelectedTags(tagList);
  }, [conversation?.conversation_id, tagKey]);

  const resetQuickReplyForm = useCallback(() => {
    setQuickReplyTitle("");
    setQuickReplyText("");
    setQuickReplyShortcut("");
    setEditingReplyId(null);
  }, []);

  const handleQuickReplyUse = useCallback((text: string) => {
    setMessageText((prev) => (prev ? `${prev}\n${text}` : text));
    setQuickRepliesOpen(false);
  }, []);

  const handleQuickReplyEdit = useCallback((reply: QuickReply) => {
    setEditingReplyId(reply.id);
    setQuickReplyTitle(reply.title);
    setQuickReplyText(reply.text);
    setQuickReplyShortcut(reply.shortcut || "");
  }, []);

  const handleQuickReplyDelete = useCallback(async (replyId: string) => {
    if (!confirm("Excluir esta resposta rapida?")) return;
    try {
      await deleteQuickReply(replyId);
      setQuickReplies((prev) => prev.filter((r) => r.id !== replyId));
      if (editingReplyId === replyId) {
        resetQuickReplyForm();
      }
    } catch (error) {
      push(`Erro ao excluir: ${(error as Error)?.message || "Erro"}`);
    }
  }, [editingReplyId, push, resetQuickReplyForm]);

  const handleQuickReplySave = useCallback(async () => {
    const title = quickReplyTitle.trim();
    const text = quickReplyText.trim();
    const shortcut = normalizeShortcut(quickReplyShortcut);

    if (!title || !text) {
      push("Preencha titulo e texto");
      return;
    }

    setIsSavingQuickReply(true);
    try {
      if (editingReplyId) {
        await updateQuickReply(editingReplyId, { title, text, shortcut });
        setQuickReplies((prev) => prev.map((r) => (
          r.id === editingReplyId ? { ...r, title, text, shortcut } : r
        )));
      } else {
        const created = await createQuickReply({ title, text, shortcut });
        setQuickReplies((prev) => [...prev, created]);
      }
      resetQuickReplyForm();
    } catch (error) {
      push(`Erro ao salvar: ${(error as Error)?.message || "Erro"}`);
    } finally {
      setIsSavingQuickReply(false);
    }
  }, [editingReplyId, push, quickReplyShortcut, quickReplyText, quickReplyTitle, resetQuickReplyForm]);

  const handleTagsToggle = useCallback((tagId: string) => {
    setSelectedTags((prev) => (
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    ));
  }, []);

  const handleTagsSave = useCallback(async () => {
    if (!conversationId) return;
    setIsSavingTags(true);
    try {
      await updateConversationTags(conversationId, selectedTags);
      updateConversationInLists(conversationId, { tags: selectedTags });
      await selectConversation(conversationId);
      setTagsOpen(false);
    } catch (error) {
      push(`Erro ao salvar tags: ${(error as Error)?.message || "Erro"}`);
    } finally {
      setIsSavingTags(false);
    }
  }, [conversationId, push, selectConversation, selectedTags, updateConversationInLists]);

  const handleSend = useCallback(async () => {
    if (!conversationId || !messageText.trim() || isSending) return;
    if (!canSend) {
      if (status === "pending_handoff") {
        push("Conversa na fila. Clique Assumir para responder.");
        return;
      }
      if (status === "bot") {
        push("Conversa com bot. Clique Assumir do Bot para responder.");
        return;
      }
      if (status === "resolved" || outsideWindow) {
        push("Conversa fora da janela de 24h. Reabra para responder.");
        return;
      }
      if (!mine) {
        const owner = assigneeLabel || "outra atendente";
        push(`Conversa em atendimento por ${owner}. Clique Assumir para responder.`);
        return;
      }
      return;
    }

    const trimmed = messageText.trim();
    const matchedReply = quickReplies.find((r) => r.shortcut && r.shortcut === trimmed);
    const textToSend = matchedReply ? matchedReply.text : trimmed;

    setIsSending(true);
    const rid = (globalThis.crypto && "randomUUID" in globalThis.crypto)
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    try {
      const response = await sendMessage(conversationId, {
        text: textToSend,
        client_request_id: rid
      });
      setMessageText("");

      const outgoing = response.message || {
        message_id: `temp:${rid}`,
        text: textToSend,
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
  }, [
    appendOptimistic,
    assigneeLabel,
    canSend,
    conversationId,
    displayName,
    isSending,
    messageText,
    mine,
    outsideWindow,
    push,
    quickReplies,
    refreshAll,
    status
  ]);

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

  const handleTakeover = useCallback(async () => {
    if (!conversationId) return;
    if (!confirm("Assumir este atendimento? A outra atendente perdera o controle da conversa.")) return;
    try {
      await takeoverConversation(conversationId);
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
      ? "Reabrir esta conversa? Um template sera enviado ao cliente e a conversa sera movida para suas conversas ativas."
      : "Reabrir esta conversa? Um template sera enviado ao cliente.";

    if (!confirm(confirmMsg)) return;

    setIsSending(true);
    try {
      const resp = await reopenConversation(conversationId);
      if (resp.old_status !== resp.new_status) {
        push(`Conversa reaberta e movida de ${resp.old_status} -> ${resp.new_status}`);

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
        body: "Esta conversa foi encerrada e esta inativa ha mais de 24 horas. Para retomar o contato, clique em \"Reabrir Conversa\" e ela sera automaticamente assumida por voce."
      }
    : {
        title: "Janela de 24h expirada",
        body: "Esta conversa esta inativa ha mais de 24 horas. Para enviar novas mensagens, voce precisa reabrir a conversa primeiro."
      };

  return (
    <>
      <div className="chat-header">
        <div style={{ fontWeight: 600 }}>Conversa:</div>
        <div className="chat-contact-info">
          <div className="contact-lines">
            <span className="contact-line">
              <strong>Nome declarado:</strong> {declaredName || "-"}
            </span>
            {conversationId ? (
              <span className="contact-line muted">
                <strong>Perfil wapp:</strong> {(waProfileName || "Sem nome")} ({conversationId})
              </span>
            ) : null}
            {showAssignee ? (
              <span className={`contact-line ${mine ? "muted" : "assignee"}`}>
                <strong>Atendente atual:</strong> {assigneeLabel}
              </span>
            ) : null}
          </div>
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
            {selectedUserName ? "Editar" : "Adicionar"}
          </button>
        </div>
        {tagList.length > 0 ? (
          <div className="tag-list">
            {tagList.map((tag, idx) => {
              const opt = getTagOption(tag);
              const label = opt?.label || tag;
              const color = opt?.color || "#334155";
              const textColor = opt?.textColor || "#e2e8f0";
              return (
                <span className="tag" style={{ background: color, color: textColor }} key={`${tag}-${idx}`}>
                  {label}
                </span>
              );
            })}
          </div>
        ) : null}
        <button
          className="btn btn-tags"
          onClick={() => {
            if (!conversationId) return;
            setSelectedTags(tagList);
            setTagsOpen(true);
          }}
          disabled={!conversationId}
        >
          Tags
        </button>
        <div className="spacer"></div>
        {canTakeover ? (
          <button className="btn btn-warn" onClick={handleTakeover}>
            Assumir atendimento
          </button>
        ) : null}
        {canClaim ? (
          <button className="btn btn-warn" onClick={handleClaim}>
            Assumir
          </button>
        ) : null}
        {canHandoff ? (
          <button className="btn btn-acc" onClick={handleHandoff}>
            Assumir do Bot
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
          <div className="notice-icon">!</div>
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
        onOpenQuickReplies={() => {
          resetQuickReplyForm();
          setQuickRepliesOpen(true);
        }}
        showReopen={outsideWindow}
        disabled={baseDisabled}
        inputDisabled={baseDisabled || !canSend}
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
              placeholder="Ex: Maria Silva, Joao, Dr. Carlos"
              maxLength={100}
            />
            <small style={{ color: "var(--muted)", fontSize: 11, marginTop: -8 }}>
              Este nome sera exibido no lugar do numero de telefone
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

      <div className={`overlay ${tagsOpen ? "show" : ""}`}>
        <div className="modal">
          <h3 style={{ margin: "0 0 12px 0" }}>Tags da Conversa</h3>
          <div className="tag-picker">
            {TAG_OPTIONS.map((tag) => {
              const selected = selectedTags.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  className={`tag-option ${selected ? "selected" : ""}`}
                  style={{
                    background: selected ? tag.color : "#0b1326",
                    color: selected ? tag.textColor || "#111" : "#cbd5f5"
                  }}
                  onClick={() => handleTagsToggle(tag.id)}
                >
                  {tag.label}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={() => setTagsOpen(false)} style={{ flex: 1 }}>
              Cancelar
            </button>
            <button className="btn btn-acc" onClick={handleTagsSave} disabled={isSavingTags} style={{ flex: 1 }}>
              {isSavingTags ? "Salvando..." : "Salvar"}
            </button>
          </div>
        </div>
      </div>

      <div className={`overlay ${quickRepliesOpen ? "show" : ""}`}>
        <div className="modal quick-replies">
          <h3 style={{ margin: "0 0 12px 0" }}>Respostas Rapidas</h3>
          <div className="quick-replies-grid">
            <div className="quick-replies-list">
              {quickReplies.length === 0 ? (
                <div className="empty-state">Nenhuma resposta rapida cadastrada</div>
              ) : (
                quickReplies.map((reply) => (
                  <div className="quick-reply-item" key={reply.id}>
                    <div className="quick-reply-main">
                      <div className="quick-reply-title">{reply.title}</div>
                      {reply.shortcut ? (
                        <div className="quick-reply-shortcut">{reply.shortcut}</div>
                      ) : null}
                      <div className="quick-reply-text">{reply.text}</div>
                    </div>
                    <div className="quick-reply-actions">
                      <button className="btn" onClick={() => handleQuickReplyUse(reply.text)}>
                        Usar
                      </button>
                      <button className="btn" onClick={() => handleQuickReplyEdit(reply)}>
                        Editar
                      </button>
                      <button className="btn btn-danger" onClick={() => handleQuickReplyDelete(reply.id)}>
                        Excluir
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="quick-replies-form">
              <label>Titulo</label>
              <input
                type="text"
                value={quickReplyTitle}
                onChange={(event) => setQuickReplyTitle(event.target.value)}
                placeholder="Ex: Bom dia"
                maxLength={60}
              />
              <label>Atalho (opcional)</label>
              <input
                type="text"
                value={quickReplyShortcut}
                onChange={(event) => setQuickReplyShortcut(event.target.value)}
                placeholder="/bomdia"
                maxLength={40}
              />
              <label>Texto</label>
              <textarea
                value={quickReplyText}
                onChange={(event) => setQuickReplyText(event.target.value)}
                placeholder="Mensagem que sera enviada"
                rows={5}
                maxLength={2000}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="btn" onClick={resetQuickReplyForm} style={{ flex: 1 }}>
                  Limpar
                </button>
                <button
                  className="btn btn-acc"
                  onClick={handleQuickReplySave}
                  disabled={isSavingQuickReply}
                  style={{ flex: 1 }}
                >
                  {isSavingQuickReply ? "Salvando..." : editingReplyId ? "Atualizar" : "Salvar"}
                </button>
              </div>
              <button className="btn" onClick={() => setQuickRepliesOpen(false)} style={{ marginTop: 8 }}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
