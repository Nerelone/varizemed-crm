import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useToast } from "../../shared/ui/Toast";
import {
  Conversation,
  getConversation,
  listConversations
} from "./conversationsApi";

export type ConversationsTab = "bot" | "pending" | "claimed" | "resolved";

type ConversationsContextValue = {
  currentTab: ConversationsTab;
  conversationsByTab: Record<ConversationsTab, Conversation[]>;
  cursorsByTab: Record<ConversationsTab, string | null>;
  hasMoreByTab: Record<ConversationsTab, boolean>;
  selectedConversation: Conversation | null;
  selectedUserName: string;
  isLoadingConversations: boolean;
  setCurrentTab: (tab: ConversationsTab) => void;
  loadTab: (tab: ConversationsTab, append?: boolean) => Promise<void>;
  loadMoreCurrent: () => Promise<void>;
  refreshAll: () => Promise<void>;
  selectConversation: (conversationId: string) => Promise<Conversation | null>;
  clearSelection: () => void;
  updateConversationInLists: (conversationId: string, updates: Partial<Conversation>) => void;
  setSelectedUserName: (name: string) => void;
};

const ConversationsContext = createContext<ConversationsContextValue | null>(null);

const TAB_CONFIG: Record<ConversationsTab, { status: string; mine?: boolean; limit?: number }> = {
  bot: { status: "bot", limit: 50 },
  pending: { status: "pending_handoff", limit: 50 },
  claimed: { status: "claimed,active", mine: true, limit: 50 },
  resolved: { status: "resolved", limit: 100 }
};

export function ConversationsProvider({ children }: { children: ReactNode }) {
  const { push } = useToast();
  const [currentTab, setCurrentTab] = useState<ConversationsTab>("bot");
  const [conversationsByTab, setConversationsByTab] = useState<Record<ConversationsTab, Conversation[]>>({
    bot: [],
    pending: [],
    claimed: [],
    resolved: []
  });
  const [cursorsByTab, setCursorsByTab] = useState<Record<ConversationsTab, string | null>>({
    bot: null,
    pending: null,
    claimed: null,
    resolved: null
  });
  const cursorsRef = useRef(cursorsByTab);
  const [hasMoreByTab, setHasMoreByTab] = useState<Record<ConversationsTab, boolean>>({
    bot: true,
    pending: true,
    claimed: true,
    resolved: true
  });
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [selectedUserName, setSelectedUserName] = useState<string>("");
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);

  useEffect(() => {
    cursorsRef.current = cursorsByTab;
  }, [cursorsByTab]);

  const loadTab = useCallback(async (tab: ConversationsTab, append = false) => {
    const config = TAB_CONFIG[tab];
    try {
      const cursor = append ? cursorsRef.current[tab] : null;
      const response = await listConversations({
        status: config.status,
        limit: config.limit,
        cursor,
        mine: config.mine
      });

      setConversationsByTab((prev) => ({
        ...prev,
        [tab]: append ? [...prev[tab], ...(response.items || [])] : response.items || []
      }));
      setCursorsByTab((prev) => ({
        ...prev,
        [tab]: response.next_cursor || null
      }));
      setHasMoreByTab((prev) => ({
        ...prev,
        [tab]: Boolean(response.next_cursor)
      }));
    } catch (error) {
      console.error(`Erro ao carregar conversas (${tab}):`, error);
      push("Erro ao carregar conversas");
    }
  }, [push]);

  const loadMoreCurrent = useCallback(async () => {
    if (isLoadingConversations || !hasMoreByTab[currentTab]) return;
    setIsLoadingConversations(true);
    try {
      await loadTab(currentTab, true);
    } finally {
      setIsLoadingConversations(false);
    }
  }, [currentTab, hasMoreByTab, isLoadingConversations, loadTab]);

  const refreshAll = useCallback(async () => {
    try {
      await Promise.all([
        loadTab("bot"),
        loadTab("pending"),
        loadTab("claimed"),
        currentTab === "resolved" ? loadTab("resolved") : Promise.resolve()
      ]);
    } catch (error) {
      console.error("Erro ao carregar dados:", error);
    }
  }, [currentTab, loadTab]);

  const selectConversation = useCallback(async (conversationId: string) => {
    try {
      const conversation = await getConversation(conversationId);
      setSelectedConversation(conversation);
      setSelectedUserName(conversation.user_name || "");
      return conversation;
    } catch (error) {
      console.error("Erro ao abrir conversa:", error);
      push("Erro ao abrir conversa");
      return null;
    }
  }, [push]);

  const clearSelection = useCallback(() => {
    setSelectedConversation(null);
    setSelectedUserName("");
  }, []);

  const updateConversationInLists = useCallback((conversationId: string, updates: Partial<Conversation>) => {
    setConversationsByTab((prev) => {
      const next = { ...prev } as Record<ConversationsTab, Conversation[]>;
      (Object.keys(next) as ConversationsTab[]).forEach((tab) => {
        const idx = next[tab].findIndex((conv) => conv.conversation_id === conversationId);
        if (idx !== -1) {
          next[tab] = [...next[tab]];
          next[tab][idx] = { ...next[tab][idx], ...updates };
        }
      });
      return next;
    });
  }, []);

  const value = useMemo<ConversationsContextValue>(() => ({
    currentTab,
    conversationsByTab,
    cursorsByTab,
    hasMoreByTab,
    selectedConversation,
    selectedUserName,
    isLoadingConversations,
    setCurrentTab,
    loadTab,
    loadMoreCurrent,
    refreshAll,
    selectConversation,
    clearSelection,
    updateConversationInLists,
    setSelectedUserName
  }), [
    currentTab,
    conversationsByTab,
    cursorsByTab,
    hasMoreByTab,
    selectedConversation,
    selectedUserName,
    isLoadingConversations,
    loadTab,
    loadMoreCurrent,
    refreshAll,
    selectConversation,
    clearSelection,
    updateConversationInLists
  ]);

  return createElement(ConversationsContext.Provider, { value }, children);
}

export function useConversationsStore() {
  const ctx = useContext(ConversationsContext);
  if (!ctx) throw new Error("useConversationsStore must be used within ConversationsProvider");
  return ctx;
}

export function getTabTitle(tab: ConversationsTab) {
  const titles: Record<ConversationsTab, string> = {
    bot: "Atendente Val",
    pending: "Fila Pendentes",
    claimed: "Atendente Humano",
    resolved: "Conversas Resolvidas"
  };
  return titles[tab];
}
