import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConnDot } from "../../shared/ui/ConnDot";
import { useToast } from "../../shared/ui/Toast";
import { useAuth } from "../auth/authStore";
import { AuthPage } from "../auth/AuthPage";
import { ChatPanel } from "../chat/ChatPanel";
import { usePolling } from "../chat/usePolling";
import { ConversationList } from "./ConversationList";
import {
  ConversationsTab,
  getTabTitle,
  useConversationsStore
} from "./conversationsStore";
import { Conversation, getConversation, reopenOutdatedConversations } from "./conversationsApi";

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

export function ConversationsPage() {
  const { push } = useToast();
  const auth = useAuth();
  const {
    currentTab,
    conversationsByTab,
    selectedConversation,
    selectedUserName,
    hasMoreByTab,
    isLoadingConversations,
    setCurrentTab,
    loadTab,
    loadMoreCurrent,
    refreshAll,
    selectConversation,
    updateConversationInLists,
    setSelectedUserName
  } = useConversationsStore();

  const [isConnected, setIsConnected] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<Conversation | null>(null);
  const [searchStatus, setSearchStatus] = useState<"idle" | "searching" | "not_found">("idle");
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const isVisible = usePageVisibility();
  const pendingCountRef = useRef(0);

  const profileIncomplete = auth.isLoaded && !auth.displayName;
  const shouldShowProfile = profileOpen || profileIncomplete;

  const conversations = conversationsByTab[currentTab];

  const searchResults = useMemo(() => {
    const query = searchQuery.trim();
    if (!query) return [];

    const all = [
      ...conversationsByTab.bot,
      ...conversationsByTab.pending,
      ...conversationsByTab.claimed,
      ...conversationsByTab.resolved
    ];

    return all.filter((conv) =>
      conv.conversation_id.includes(query) ||
      (conv.last_message_text || "").includes(query)
    );
  }, [searchQuery, conversationsByTab]);

  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const handler = () => setIsConnected(navigator.onLine);
    window.addEventListener("online", handler);
    window.addEventListener("offline", handler);
    return () => {
      window.removeEventListener("online", handler);
      window.removeEventListener("offline", handler);
    };
  }, []);

  useEffect(() => {
    const handler = () => setAdminMenuOpen(false);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  useEffect(() => {
    refreshAll().then(() => setIsConnected(true)).catch(() => setIsConnected(false));
  }, [refreshAll]);

  usePolling(
    async () => {
      try {
        await refreshAll();
        setIsConnected(true);
      } catch {
        setIsConnected(false);
      }
    },
    10000,
    isVisible
  );

  usePolling(
    async () => {
      try {
        await loadTab("pending");
        setIsConnected(true);
      } catch {
        setIsConnected(false);
      }
    },
    60000,
    !isVisible
  );

  useEffect(() => {
    const pendingCount = conversationsByTab.pending.length;
    if (pendingCount > 0 && pendingCount > pendingCountRef.current && !isVisible) {
      showDesktopNotification("Nova conversa pendente!", `${pendingCount} conversa(s) aguardando atendimento`);
    }
    pendingCountRef.current = pendingCount;
  }, [conversationsByTab.pending.length, isVisible]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResult(null);
      setSearchStatus("idle");
      return;
    }

    if (searchResults.length > 0) {
      setSearchResult(null);
      setSearchStatus("idle");
      return;
    }

    setSearchStatus("searching");
    const handle = window.setTimeout(async () => {
      try {
        const conv = await getConversation(query);
        setSearchResult(conv);
        setSearchStatus("idle");
      } catch {
        setSearchResult(null);
        setSearchStatus("not_found");
      }
    }, 300);

    return () => window.clearTimeout(handle);
  }, [searchQuery, searchResults.length]);

  const handleTabChange = useCallback((tab: ConversationsTab) => {
    setCurrentTab(tab);
    if (tab === "resolved") {
      loadTab("resolved");
    }
  }, [loadTab, setCurrentTab]);

  const handleSelectConversation = useCallback(async (conversationId: string) => {
    await selectConversation(conversationId);
  }, [selectConversation]);

  const handleAdminAction = useCallback(async () => {
    if (!confirm("Tem certeza que deseja reabrir todas as conversas não resolvidas fora da janela de 24h?")) {
      return;
    }

    try {
      await reopenOutdatedConversations();
      push("Conversas reabertas com sucesso!");
      await refreshAll();
    } catch (error) {
      push(`Erro: ${(error as Error)?.message || "Falha ao reabrir conversas"}`);
    } finally {
      setAdminMenuOpen(false);
    }
  }, [push, refreshAll]);

  const listTitle = getTabTitle(currentTab);
  const showPendingAlert = conversationsByTab.pending.length > 0;
  const isSearchMode = Boolean(searchQuery.trim());

  const listConversations: Conversation[] = searchQuery.trim()
    ? (searchResults.length > 0 ? searchResults : searchResult ? [searchResult] : [])
    : conversations;

  const emptyLabel = searchQuery.trim()
    ? (searchStatus === "searching" ? "Buscando..." : "Nenhuma conversa encontrada")
    : "Nenhuma conversa nesta categoria";

  return (
    <>
      <div className="top">
        <div className="brand">Varizemed • CRM</div>
        <div className="admin-icons">
          <div className="icon-dropdown">
            <button
              className="icon-btn"
              title="Ferramentas Administrativas"
              onClick={(event) => {
                event.stopPropagation();
                setAdminMenuOpen((prev) => !prev);
              }}
            >
              🔧
            </button>
            <div className={`dropdown-menu ${adminMenuOpen ? "show" : ""}`}>
              <button className="dropdown-item" onClick={handleAdminAction}>
                Reabrir conversas fora de 24h não resolvidas
              </button>
            </div>
          </div>
          <button className="icon-btn" title="Agenda" disabled>
            📅
          </button>
        </div>
        <div className="spacer"></div>
        <ConnDot connected={isConnected} />
        <button className="btn" onClick={() => setProfileOpen(true)}>
          Configurar
        </button>
      </div>

      <div className="layout" onClick={() => setAdminMenuOpen(false)}>
        <div className="tabs-container">
          <div className="tabs">
            <button
              className={`tab ${currentTab === "bot" ? "active" : ""}`}
              onClick={() => handleTabChange("bot")}
            >
              Atendente Val
            </button>
            <button
              className={`tab ${currentTab === "pending" ? "active" : ""} ${showPendingAlert ? "alert" : ""}`}
              onClick={() => handleTabChange("pending")}
            >
              Fila
            </button>
            <button
              className={`tab ${currentTab === "claimed" ? "active" : ""}`}
              onClick={() => handleTabChange("claimed")}
            >
              Atendente Humano
            </button>
            <button
              className={`tab ${currentTab === "resolved" ? "active" : ""}`}
              onClick={() => handleTabChange("resolved")}
            >
              Resolvidos
            </button>
          </div>

          <div className="search-box">
            <span className="search-icon">🔍</span>
            <input
              placeholder="Digite o número de telefone..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>

          <div className="card">
            <h3>{listTitle}</h3>
            <ConversationList
              conversations={listConversations}
              selectedId={selectedConversation?.conversation_id || null}
              onSelect={handleSelectConversation}
              onLoadMore={loadMoreCurrent}
              hasMore={isSearchMode ? false : hasMoreByTab[currentTab]}
              isLoading={isSearchMode ? false : isLoadingConversations}
              emptyLabel={emptyLabel}
            />
          </div>
        </div>

        <div className="card chat">
          <ChatPanel
            conversation={selectedConversation}
            selectedUserName={selectedUserName}
            onUserNameChange={setSelectedUserName}
            updateConversationInLists={updateConversationInLists}
          />
        </div>
      </div>

      <AuthPage
        open={shouldShowProfile}
        canClose={!profileIncomplete}
        onClose={() => setProfileOpen(false)}
      />
    </>
  );
}
