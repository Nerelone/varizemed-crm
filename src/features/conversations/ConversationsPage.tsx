import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConnDot } from "../../shared/ui/ConnDot";
import { TAG_OPTIONS } from "../../shared/constants/tags";
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
import {
  Conversation,
  getReopenBatchCapabilities,
  ReopenBatchResponse,
  ReopenBatchScope,
  reopenOutdatedConversations,
  searchConversations
} from "./conversationsApi";

const KNOWN_TAG_IDS = new Set(TAG_OPTIONS.map((tag) => tag.id));

function normalizeTagToken(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]/g, "");
}

function extractTagQuery(value: string): string | null {
  const query = value.trim();
  if (!query) return null;

  let candidate = query;
  const lower = query.toLowerCase();
  const isExplicitTag = lower.startsWith("tag:") || query.startsWith("#");
  if (lower.startsWith("tag:")) {
    candidate = query.slice(4).trim();
  } else if (query.startsWith("#")) {
    candidate = query.slice(1).trim();
  }

  const normalized = normalizeTagToken(candidate);
  if (!normalized) return null;
  if (isExplicitTag) return normalized;
  return KNOWN_TAG_IDS.has(normalized) ? normalized : null;
}

type ReopenBatchCapabilitiesState = {
  isStaging: boolean;
  hasStagingTestScope: boolean;
  testPhoneCount: number;
};

type ReopenResultDialogState = {
  mode: "preview" | "execute";
  scopeLabel: string;
  eligibleCount: number;
  skippedWindowOpen: number;
  skippedRecent: number;
  skippedNotAllowed: number;
  checked: number;
  reopenedCount: number;
  errorCount: number;
  sampleConversations: NonNullable<ReopenBatchResponse["sample_conversations"]>;
};

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

function formatPreviewTimestamp(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("pt-BR");
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
  const [remoteSearchResults, setRemoteSearchResults] = useState<Conversation[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "searching" | "not_found">("idle");
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [reopenResultDialog, setReopenResultDialog] = useState<ReopenResultDialogState | null>(null);
  const [reopenCapabilities, setReopenCapabilities] = useState<ReopenBatchCapabilitiesState>({
    isStaging: false,
    hasStagingTestScope: false,
    testPhoneCount: 0
  });

  const isVisible = usePageVisibility();
  const pendingCountRef = useRef(0);

  const profileIncomplete = auth.isLoaded && !auth.displayName;
  const shouldShowProfile = profileOpen || profileIncomplete;

  const conversations = conversationsByTab[currentTab];
  const activeTagQuery = useMemo(() => extractTagQuery(searchQuery), [searchQuery]);

  const localSearchResults = useMemo(() => {
    const query = searchQuery.trim();
    if (!query) return [];

    const all = [
      ...conversationsByTab.bot,
      ...conversationsByTab.pending,
      ...conversationsByTab.claimed,
      ...conversationsByTab.resolved
    ];

    if (activeTagQuery) {
      return all.filter((conv) =>
        (conv.tags || []).some((tag) => normalizeTagToken(String(tag || "")) === activeTagQuery)
      );
    }

    return all.filter((conv) =>
      conv.conversation_id.includes(query) ||
      (conv.last_message_text || "").includes(query)
    );
  }, [activeTagQuery, conversationsByTab, searchQuery]);

  const searchResults = useMemo(() => {
    const query = searchQuery.trim();
    if (!query) return [];

    const merged = new Map<string, Conversation>();
    for (const conv of localSearchResults) {
      merged.set(conv.conversation_id, conv);
    }
    for (const conv of remoteSearchResults) {
      if (!merged.has(conv.conversation_id)) {
        merged.set(conv.conversation_id, conv);
      }
    }
    return Array.from(merged.values());
  }, [localSearchResults, remoteSearchResults, searchQuery]);

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
    let cancelled = false;
    getReopenBatchCapabilities()
      .then((capabilities) => {
        if (cancelled) return;
        setReopenCapabilities({
          isStaging: Boolean(capabilities.is_staging),
          hasStagingTestScope: Boolean(capabilities.has_staging_test_scope),
          testPhoneCount: Number(capabilities.test_phone_count || 0)
        });
      })
      .catch(() => {
        if (cancelled) return;
        setReopenCapabilities({
          isStaging: false,
          hasStagingTestScope: false,
          testPhoneCount: 0
        });
      });

    return () => {
      cancelled = true;
    };
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
      setRemoteSearchResults([]);
      setSearchStatus("idle");
      return;
    }

    setRemoteSearchResults([]);

    if (localSearchResults.length > 0) {
      setSearchStatus("idle");
    } else {
      setSearchStatus("searching");
    }

    let cancelled = false;
    const handle = window.setTimeout(async () => {
      try {
        const response = await searchConversations({ query, limit: 50 });
        if (cancelled) return;
        const items = response.items || [];
        setRemoteSearchResults(items);
        if (items.length > 0 || localSearchResults.length > 0) {
          setSearchStatus("idle");
        } else {
          setSearchStatus("not_found");
        }
      } catch {
        if (cancelled) return;
        setRemoteSearchResults([]);
        if (localSearchResults.length > 0) {
          setSearchStatus("idle");
        } else {
          setSearchStatus("not_found");
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [localSearchResults.length, searchQuery]);

  const handleTabChange = useCallback((tab: ConversationsTab) => {
    setCurrentTab(tab);
    if (tab === "resolved") {
      loadTab("resolved");
    }
  }, [loadTab, setCurrentTab]);

  const handleTagShortcut = useCallback((tagId: string) => {
    setSearchQuery(`tag:${tagId}`);
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    setRemoteSearchResults([]);
    setSearchStatus("idle");
  }, []);

  const handleSelectConversation = useCallback(async (conversationId: string) => {
    await selectConversation(conversationId);
  }, [selectConversation]);

  const handleReopenBatchAction = useCallback(async (scope: ReopenBatchScope, preview: boolean) => {
    const scopeLabel =
      scope === "bot"
        ? "Bot"
        : scope === "active"
          ? "Ativas"
          : "Teste (staging)";

    const stagingPhonesText =
      reopenCapabilities.testPhoneCount > 0
        ? ` (${reopenCapabilities.testPhoneCount} numero(s) autorizado(s))`
        : "";

    let confirmMessage = "";
    if (scope === "bot" && !preview) {
      confirmMessage = "Voce vai reabrir todas as conversas fora da janela de 24h em Bot. Confirme a operacao.";
    } else if (scope === "active" && !preview) {
      confirmMessage = "Voce vai reabrir todas as conversas fora da janela de 24h em Ativas. Confirme a operacao.";
    } else if (scope === "staging_test" && !preview) {
      confirmMessage = `Voce vai reabrir somente as conversas de teste${stagingPhonesText} fora da janela de 24h. Confirme a operacao.`;
    } else if (scope === "staging_test" && preview) {
      confirmMessage = `Voce vai pre-visualizar somente as conversas de teste${stagingPhonesText} fora da janela de 24h. Nenhuma mensagem sera enviada. Confirma?`;
    } else {
      confirmMessage = `Voce vai pre-visualizar a reabertura de conversas ${scopeLabel} fora da janela de 24h. Nenhuma mensagem sera enviada. Confirma?`;
    }

    if (!confirm(confirmMessage)) {
      return;
    }

    try {
      const result = await reopenOutdatedConversations({ scope, preview });
      if (preview) {
        setReopenResultDialog({
          mode: "preview",
          scopeLabel,
          eligibleCount: Number(result.eligible_count || 0),
          skippedWindowOpen: Number(result.skipped_window_open || 0),
          skippedRecent: Number(result.skipped_recent || 0),
          skippedNotAllowed: Number(result.skipped_not_allowed || 0),
          checked: Number(result.checked || 0),
          reopenedCount: Number(result.reopened_count || 0),
          errorCount: Array.isArray(result.errors) ? result.errors.length : 0,
          sampleConversations: Array.isArray(result.sample_conversations) ? result.sample_conversations : []
        });
      } else {
        setReopenResultDialog({
          mode: "execute",
          scopeLabel,
          eligibleCount: Number(result.eligible_count || 0),
          skippedWindowOpen: Number(result.skipped_window_open || 0),
          skippedRecent: Number(result.skipped_recent || 0),
          skippedNotAllowed: Number(result.skipped_not_allowed || 0),
          checked: Number(result.checked || 0),
          reopenedCount: Number(result.reopened_count || 0),
          errorCount: Array.isArray(result.errors) ? result.errors.length : 0,
          sampleConversations: []
        });
        await refreshAll();
      }
    } catch (error) {
      push(`Erro: ${(error as Error)?.message || "Falha ao processar reabertura em lote"}`);
    } finally {
      setAdminMenuOpen(false);
    }
  }, [push, refreshAll, reopenCapabilities.testPhoneCount]);

  const listTitle = getTabTitle(currentTab);
  const showPendingAlert = conversationsByTab.pending.length > 0;
  const isSearchMode = Boolean(searchQuery.trim());

  const listConversations: Conversation[] = searchQuery.trim()
    ? searchResults
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
            <div
              className={`dropdown-menu ${adminMenuOpen ? "show" : ""}`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="dropdown-label">Reabertura em lote (fora da janela de 24h)</div>
              <button className="dropdown-item" onClick={() => handleReopenBatchAction("bot", true)}>
                Pré-visualizar Bot
              </button>
              <button className="dropdown-item" onClick={() => handleReopenBatchAction("bot", false)}>
                Reabrir Bot
              </button>
              <button className="dropdown-item" onClick={() => handleReopenBatchAction("active", true)}>
                Pré-visualizar Ativas
              </button>
              <button className="dropdown-item" onClick={() => handleReopenBatchAction("active", false)}>
                Reabrir Ativas
              </button>
              {reopenCapabilities.hasStagingTestScope ? (
                <>
                  <div className="dropdown-divider" />
                  <div className="dropdown-label">Teste no Staging</div>
                  <button className="dropdown-item" onClick={() => handleReopenBatchAction("staging_test", true)}>
                    Pré-visualizar Teste
                  </button>
                  <button className="dropdown-item" onClick={() => handleReopenBatchAction("staging_test", false)}>
                    Reabrir Teste
                  </button>
                </>
              ) : null}
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
              placeholder="Telefone ou tag (ex.: tag:urgente)"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            {searchQuery.trim() ? (
              <button
                type="button"
                className="search-clear-btn"
                onClick={handleClearSearch}
                title="Limpar busca"
              >
                Limpar
              </button>
            ) : null}
          </div>
          <div className="search-tags">
            {TAG_OPTIONS.map((tag) => {
              const isActive = activeTagQuery === tag.id;
              return (
                <button
                  key={tag.id}
                  className={`search-tag-chip ${isActive ? "active" : ""}`}
                  style={isActive ? { background: tag.color, color: tag.textColor || "#111", borderColor: tag.color } : undefined}
                  onClick={() => handleTagShortcut(tag.id)}
                  type="button"
                >
                  {tag.label}
                </button>
              );
            })}
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

      <div className={`overlay ${reopenResultDialog ? "show" : ""}`}>
        <div className="modal reopen-preview-modal">
          <h3 style={{ margin: "0 0 10px 0" }}>
            {reopenResultDialog?.mode === "preview" ? "Pré-visualização" : "Reabertura concluída"} • {reopenResultDialog?.scopeLabel || ""}
          </h3>
          <p className="reopen-preview-note">
            {reopenResultDialog?.mode === "preview"
              ? "Nenhuma mensagem foi enviada. Este resultado mostra o que aconteceria na execução real."
              : "A reabertura foi executada. Confira o resumo abaixo."}
          </p>
          <div className="reopen-preview-stats">
            {reopenResultDialog?.mode === "execute" ? (
              <>
                <div><strong>Reabertas:</strong> {reopenResultDialog?.reopenedCount || 0}</div>
                <div><strong>Erros:</strong> {reopenResultDialog?.errorCount || 0}</div>
              </>
            ) : null}
            <div><strong>Elegíveis:</strong> {reopenResultDialog?.eligibleCount || 0}</div>
            <div><strong>Dentro da janela:</strong> {reopenResultDialog?.skippedWindowOpen || 0}</div>
            <div><strong>Reabertura recente:</strong> {reopenResultDialog?.skippedRecent || 0}</div>
            <div><strong>Fora da whitelist:</strong> {reopenResultDialog?.skippedNotAllowed || 0}</div>
            <div><strong>Avaliadas:</strong> {reopenResultDialog?.checked || 0}</div>
          </div>

          {reopenResultDialog?.mode === "preview" ? (
            <div className="reopen-preview-list">
              {(reopenResultDialog?.sampleConversations || []).length === 0 ? (
                <div className="empty-state">Nenhuma conversa elegível para mostrar na amostra.</div>
              ) : (
                (reopenResultDialog?.sampleConversations || []).map((item) => (
                  <div className="reopen-preview-item" key={item.conversation_id}>
                    <div><strong>{item.conversation_id}</strong></div>
                    <div>Status: {item.status || "-"}</div>
                    <div>Atualizada em: {formatPreviewTimestamp(item.updated_at)}</div>
                    <div className="reopen-preview-text">{item.last_message_text || "-"}</div>
                  </div>
                ))
              )}
            </div>
          ) : null}

          <div className="reopen-preview-actions">
            <button className="btn btn-acc" onClick={() => setReopenResultDialog(null)}>
              Fechar
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
