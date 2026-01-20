// ====== State ======
const state = {
  username: '',
  displayName: localStorage.getItem('crm_display_name') || '',
  usePrefix: localStorage.getItem('crm_use_prefix') === 'true',
  currentTab: 'bot', // bot, pending, claimed, resolved
  conversations: {
    bot: [],
    pending: [],
    claimed: [],
    resolved: []
  },
  selectedId: null,
  selectedUserName: '', // Nome do cliente da conversa selecionada
  sending: false,
  outside24hWindow: false,
  pollingInterval: null,
  convPollingInterval: null,
  backgroundPollingInterval: null,
  isPageVisible: !document.hidden,
  lastPendingCount: 0,
  
  // Infinite scroll state para mensagens
  messageCursor: null,
  hasMoreMessages: true,
  isLoadingMessages: false,
  scrollDebounceTimer: null,
  
  // Infinite scroll state para conversas (por aba)
  conversationCursors: {
    bot: null,
    pending: null,
    claimed: null,
    resolved: null
  },
  hasMoreConversations: {
    bot: true,
    pending: true,
    claimed: true,
    resolved: true
  },
  isLoadingConversations: false,
  convScrollDebounceTimer: null
};

const els = {
  // Tabs
  tabBot: document.getElementById('tabBot'),
  tabPending: document.getElementById('tabPending'),
  tabClaimed: document.getElementById('tabClaimed'),
  tabResolved: document.getElementById('tabResolved'),
  
  // Lists
  convList: document.getElementById('convList'),
  listTitle: document.getElementById('listTitle'),
  
  // Chat
  chatId: document.getElementById('chatConvId'),
  chatCustomerName: document.getElementById('chatCustomerName'),
  btnEditName: document.getElementById('btnEditName'),
  chatBody: document.getElementById('chatBody'),
  inpMsg: document.getElementById('inpMsg'),
  btnSend: document.getElementById('btnSend'),
  btnResolve: document.getElementById('btnResolve'),
  btnClaim: document.getElementById('btnClaim'),
  btnHandoff: document.getElementById('btnHandoff'),
  btnReopen: document.getElementById('btnReopen'),
  windowClosedNotice: document.getElementById('windowClosedNotice'),
  
  // Search
  inpSearch: document.getElementById('inpSearch'),
  
  // UI
  toast: document.getElementById('toast'),
  ovl: document.getElementById('ovl'),
  cfgUsername: document.getElementById('cfgUsername'),
  cfgDisplayName: document.getElementById('cfgDisplayName'),
  cfgUsePrefixToggle: document.getElementById('cfgUsePrefixToggle'),
  cfgUsePrefixContainer: document.getElementById('cfgUsePrefixContainer'),
  btnSaveCfg: document.getElementById('btnSaveCfg'),
  btnSettings: document.getElementById('btnSettings'),
  connDot: document.getElementById('connDot'),
  
  // Modal de edição de nome
  ovlEditName: document.getElementById('ovlEditName'),
  inpCustomerName: document.getElementById('inpCustomerName'),
  btnSaveCustomerName: document.getElementById('btnSaveCustomerName'),
  btnCancelEditName: document.getElementById('btnCancelEditName')
};

// ====== Message Comparison (Deterministic) ======
function cmpMsg(a, b) {
  const ta = new Date(a.ts).getTime() || 0;
  const tb = new Date(b.ts).getTime() || 0;
  if (ta !== tb) return ta - tb;
  // desempate determinístico por message_id
  const ia = (a.message_id || '');
  const ib = (b.message_id || '');
  if (ia !== ib) return ia < ib ? -1 : 1;
  return 0;
}

// ====== UI helpers ======
function setConnDot(ok) { 
  els.connDot.style.color = ok ? '#22c55e' : '#9ca3af'; 
  els.connDot.title = ok ? 'Polling ativo' : 'Desconectado';
}

function fmt(ts) { 
  if(!ts) return ''; 
  const d = new Date(ts); 
  const now = new Date();
  const diff = now - d;
  
  // Menos de 1 minuto
  if (diff < 60000) return 'agora';
  // Menos de 1 hora
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
  // Menos de 24 horas
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
  // Menos de 7 dias
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd';
  
  return d.toLocaleDateString('pt-BR', {day:'2-digit', month:'2-digit'});
}

function toast(msg) { 
  const t = document.createElement('div'); 
  t.className = 't'; 
  t.textContent = msg; 
  els.toast.appendChild(t); 
  setTimeout(() => t.remove(), 4000); 
}

function escapeHtml(s) { 
  return (s || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]); 
}

// ====== Status Label Helper ======
function getStatusLabel(status) {
  const labels = {
    'bot': 'Val',
    'claimed': 'Humano',
    'active': 'Humano',
    'pending_handoff': 'Fila',
    'resolved': 'Resolvido'
  };
  return labels[status] || status;
}

// ====== Avatar Helper ======
function getAvatarInitials(phone) {
  // Extrai os últimos 4 dígitos do número
  const digits = phone.replace(/\D/g, '');
  return digits.slice(-4, -2) || '??';
}

function getAvatarColor(phone) {
  // Gera cor baseada no hash do número
  let hash = 0;
  for (let i = 0; i < phone.length; i++) {
    hash = phone.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
    'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
    'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
    'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
    'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
    'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
    'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)'
  ];
  return colors[Math.abs(hash) % colors.length];
}

// ====== Loading Indicator ======
function showLoadingIndicator() {
  let indicator = document.getElementById('loadingIndicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'loadingIndicator';
    indicator.style.cssText = 'text-align:center; padding:10px; color:var(--muted); font-size:12px;';
    indicator.textContent = ' Carregando mensagens antigas...';
  }
  if (els.chatBody.firstChild) {
    els.chatBody.insertBefore(indicator, els.chatBody.firstChild);
  } else {
    els.chatBody.appendChild(indicator);
  }
}

function hideLoadingIndicator() {
  const indicator = document.getElementById('loadingIndicator');
  if (indicator) indicator.remove();
}

// ====== Toggle Helper ======
function updateToggleVisibility() {
  if (state.usePrefix) {
    els.cfgUsePrefixContainer.style.display = 'grid';
  } else {
    els.cfgUsePrefixContainer.style.display = 'none';
  }
}

// ====== 24h Window Management ======
async function check24hWindow(conversationId) {
  console.log('[EMJ] Verificando janela 24h para:', conversationId);
  
  try {
    const resp = await api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/window-status`);
    
    console.log('[EMJ] Resposta do servidor:', resp);
    console.log('[EMJ] Fora da janela 24h?', resp.outside_24h_window);
    
    state.outside24hWindow = resp.outside_24h_window;
    
    // Atualiza texto do aviso baseado no contexto
    if (state.outside24hWindow) {
      console.log('  CONVERSA FORA DA JANELA - Atualizando UI');
      
      const conv = state.conversations.bot.find(c => c.conversation_id === conversationId) ||
                   state.conversations.pending.find(c => c.conversation_id === conversationId) ||
                   state.conversations.claimed.find(c => c.conversation_id === conversationId) ||
                   state.conversations.resolved.find(c => c.conversation_id === conversationId);
      
      const isResolved = conv && conv.status === 'resolved';
      
      console.log('[EMJ] Status da conversa:', conv?.status);
      console.log('[EMJ] É resolved?', isResolved);
      
      if (isResolved) {
        els.windowClosedNotice.querySelector('.notice-content strong').textContent = 
          'Conversa encerrada - Janela de 24h expirada';
        els.windowClosedNotice.querySelector('.notice-content p').textContent = 
          'Esta conversa foi encerrada e está inativa há mais de 24 horas. Para retomar o contato, clique em "Reabrir Conversa" e ela será automaticamente assumida por você.';
      } else {
        els.windowClosedNotice.querySelector('.notice-content strong').textContent = 
          'Janela de 24h expirada';
        els.windowClosedNotice.querySelector('.notice-content p').textContent = 
          'Esta conversa está inativa há mais de 24 horas. Para enviar novas mensagens, você precisa reabrir a conversa primeiro.';
      }
    } else {
      console.log(' Conversa dentro da janela - UI normal');
    }
    
    update24hWindowUI();
    
    console.log('[ARTE] UI atualizada. Estado final:');
    console.log('  - Input visível:', els.inpMsg.style.display !== 'none');
    console.log('  - Botão Enviar visível:', els.btnSend.style.display !== 'none');
    console.log('  - Botão Reabrir visível:', els.btnReopen.style.display !== 'none');
    console.log('  - Aviso visível:', els.windowClosedNotice.style.display !== 'none');
    
  } catch (e) {
    console.error(' Erro ao verificar janela 24h:', e);
    state.outside24hWindow = false;
    update24hWindowUI();
  }
}

function update24hWindowUI() {
  if (state.outside24hWindow) {
    // Esconde input normal e botão enviar
    els.inpMsg.style.display = 'none';
    els.btnSend.style.display = 'none';
    
    // Mostra botão de reabertura
    els.btnReopen.style.display = 'block';
    
    // Mostra aviso
    els.windowClosedNotice.style.display = 'flex';
  } else {
    // Mostra input normal e botão enviar
    els.inpMsg.style.display = 'block';
    els.btnSend.style.display = 'block';
    
    // Esconde botão de reabertura
    els.btnReopen.style.display = 'none';
    
    // Esconde aviso
    els.windowClosedNotice.style.display = 'none';
  }
}

async function reopenConversation() {
  if (!state.selectedId || state.sending) return;
  
  const confirmMsg = state.currentTab === 'resolved' 
    ? 'Reabrir esta conversa? Um template será enviado ao cliente e a conversa será movida para suas conversas ativas.'
    : 'Reabrir esta conversa? Um template será enviado ao cliente.';
  
  if (!confirm(confirmMsg)) {
    return;
  }
  
  state.sending = true;
  els.btnReopen.disabled = true;
  els.btnReopen.textContent = ' Reabrindo...';
  
  try {
    const resp = await api(`/api/admin/conversations/${encodeURIComponent(state.selectedId)}/reopen`, {
      method: 'POST'
    });
    
    console.log(' Conversa reaberta:', resp);
    
    const statusChanged = resp.old_status !== resp.new_status;
    
    if (statusChanged) {
      toast(` Conversa reaberta e movida de ${resp.old_status}  ${resp.new_status}`);
      
      // Remove da lista atual e recarrega
      if (resp.old_status === 'resolved') {
        await loadResolved();
        // Muda para aba claimed onde a conversa está agora
        await loadClaimed();
        switchTab('claimed');
      } else if (resp.old_status === 'pending_handoff') {
        await loadPending();
        await loadClaimed();
        switchTab('claimed');
      }
      
      // Atualiza botões para refletir novo status
      if (resp.new_status === 'claimed') {
        els.btnResolve.style.display = 'inline-block';
        els.btnClaim.style.display = 'none';
        els.btnHandoff.style.display = 'none';
      }
    } else {
      toast(' Conversa reaberta com sucesso!');
    }
    
    // Atualiza status da janela
    state.outside24hWindow = false;
    update24hWindowUI();
    
    // Recarrega mensagens para mostrar o template enviado
    await refreshMessages(state.selectedId);
    
    // Foca no input
    els.inpMsg.focus();
    
  } catch (e) {
    console.error(' Erro ao reabrir conversa:', e);
    toast(' Erro ao reabrir conversa: ' + (e.message || 'Erro desconhecido'));
  } finally {
    state.sending = false;
    els.btnReopen.disabled = false;
    els.btnReopen.textContent = '[EMJ] Reabrir Conversa';
  }
}

// ====== Customer Name Management ======
function updateCustomerNameDisplay(phoneNumber, customerName) {
  // Atualiza exibicao do numero/nome no cabecalho
  els.chatId.textContent = phoneNumber;
  
  if (customerName) {
    els.chatCustomerName.textContent = customerName;
    els.chatCustomerName.style.display = 'inline';
    els.btnEditName.textContent = '✏️';
    els.btnEditName.title = 'Editar nome';
  } else {
    els.chatCustomerName.textContent = '';
    els.chatCustomerName.style.display = 'none';
    els.btnEditName.textContent = '➕';
    els.btnEditName.title = 'Adicionar nome';
  }
}

function openEditNameModal() {
  if (!state.selectedId) return;
  
  els.inpCustomerName.value = state.selectedUserName || '';
  els.ovlEditName.classList.add('show');
  els.inpCustomerName.focus();
}

function closeEditNameModal() {
  els.ovlEditName.classList.remove('show');
}

async function saveCustomerName() {
  const id = state.selectedId;
  if (!id) return;
  
  const newName = els.inpCustomerName.value.trim();
  if (!newName) {
    toast('Digite um nome para o cliente');
    return;
  }
  
  if (newName.length > 100) {
    toast('Nome muito longo (max 100 caracteres)');
    return;
  }
  
  els.btnSaveCustomerName.disabled = true;
  els.btnSaveCustomerName.textContent = 'Salvando...';
  
  try {
    await api(`/api/admin/conversations/${encodeURIComponent(id)}/user-name`, {
      method: 'POST',
      body: { user_name: newName }
    });
    
    // Atualiza estado local
    state.selectedUserName = newName;
    
    // Atualiza exibicao
    updateCustomerNameDisplay(id, newName);
    
    // Atualiza na lista de conversas em memoria
    updateConversationInLists(id, { user_name: newName });
    
    // Re-renderiza lista
    renderConversationList();
    
    closeEditNameModal();
    toast('Nome salvo com sucesso!');
    
  } catch (e) {
    console.error('Erro ao salvar nome:', e);
    toast('Erro ao salvar nome: ' + (e.message || 'Erro desconhecido'));
  } finally {
    els.btnSaveCustomerName.disabled = false;
    els.btnSaveCustomerName.textContent = 'Salvar';
  }
}

function updateConversationInLists(conversationId, updates) {
  // Atualiza conversa em todas as listas
  const tabs = ['bot', 'pending', 'claimed', 'resolved'];
  
  for (const tab of tabs) {
    const convs = state.conversations[tab];
    const idx = convs.findIndex(c => c.conversation_id === conversationId);
    if (idx !== -1) {
      state.conversations[tab][idx] = { ...convs[idx], ...updates };
    }
  }
}

// ====== Debug Helper ======
window.debugMessageOrder = function() {
  const bubbles = Array.from(els.chatBody.querySelectorAll('.bubble'));
  console.log('[EMJ] Verificando ordem das mensagens:');
  console.log(`Total: ${bubbles.length} mensagens`);
  
  let isOrdered = true;
  let prevTimestamp = null;
  
  const results = [];
  
  bubbles.forEach((bubble, index) => {
    const timestamp = bubble.dataset.timestamp;
    const messageId = bubble.dataset.messageId;
    const direction = bubble.classList.contains('me') ? 'out' : 'in';
    const text = bubble.textContent.split('•')[0].trim().substring(0, 40);
    
    if (prevTimestamp && timestamp < prevTimestamp) {
      console.error(` Fora de ordem no índice ${index}:`);
      console.error(`   Anterior: ${prevTimestamp}`);
      console.error(`   Atual: ${timestamp}`);
      console.error(`   Texto: ${text}`);
      isOrdered = false;
    }
    
    results.push({
      index,
      timestamp,
      direction,
      text,
      messageId
    });
    
    prevTimestamp = timestamp;
  });
  
  // Mostra as primeiras 5 e últimas 5
  console.log('\n[EMJ] Primeiras 5 mensagens:');
  results.slice(0, 5).forEach(r => {
    console.log(`  [${r.index}] ${r.timestamp} [${r.direction}] ${r.text}`);
  });
  
  if (results.length > 10) {
    console.log(`  ... (${results.length - 10} mensagens no meio) ...`);
  }
  
  console.log('\n[EMJ] Últimas 5 mensagens:');
  results.slice(-5).forEach(r => {
    console.log(`  [${r.index}] ${r.timestamp} [${r.direction}] ${r.text}`);
  });
  
  console.log('\n');
  
  if (isOrdered) {
    console.log(' Todas as mensagens estão na ordem correta (mais antiga  mais recente)!');
  } else {
    console.error(' Há mensagens fora de ordem! Veja os erros acima.');
  }
  
  return { isOrdered, messages: results };
};

window.debug24hWindow = async function(conversationId) {
  const id = conversationId || state.selectedId;
  if (!id) {
    console.error(' Nenhuma conversa selecionada. Use: debug24hWindow("+5531999999999")');
    return;
  }
  
  console.log('[EMJ] Diagnosticando janela 24h para:', id);
  console.log('');
  
  try {
    const resp = await api(`/api/admin/conversations/${encodeURIComponent(id)}/window-debug`);
    
    console.log('[EMJ] RESULTADO DO DIAGNOSTICO:');
    console.log('');
    console.log('');
    console.log('[EMJ] Fora da janela 24h?', resp.outside_24h_window ? ' SIM' : ' NAO');
    console.log('[EMJ] Mensagens inbound encontradas:', resp.total_inbound_messages_checked);
    console.log('');
    
    if (resp.messages && resp.messages.length > 0) {
      console.log('[EMJ] Últimas mensagens inbound:');
      console.log('');
      
      resp.messages.forEach((msg, i) => {
        console.log(`  ${i + 1}. ${msg.is_outside_24h ? '[X]' : '[OK]'} ${msg.hours_ago}h atras`);
        console.log(`     Texto: "${msg.text}"`);
        console.log(`     Timestamp: ${msg.parsed_timestamp}`);
        console.log('');
      });
    } else {
      console.warn('  Nenhuma mensagem inbound encontrada!');
      console.log('   Isso significa que:');
      console.log('   - A conversa não tem mensagens do cliente ainda');
      console.log('   - OU todas as mensagens são outbound (enviadas pelo bot/agente)');
    }
    
    console.log('');
    console.log('');
    console.log('[EMJ] Estado atual da UI:');
    console.log('   - Input visível:', els.inpMsg.style.display !== 'none');
    console.log('   - Botão Enviar visível:', els.btnSend.style.display !== 'none');
    console.log('   - Botão Reabrir visível:', els.btnReopen.style.display !== 'none');
    console.log('   - Aviso visível:', els.windowClosedNotice.style.display !== 'none');
    console.log('   - state.outside24hWindow:', state.outside24hWindow);
    
    return resp;
    
  } catch (e) {
    console.error(' Erro ao diagnosticar:', e);
    return null;
  }
};

console.log('[EMJ] Funções de debug disponíveis:');
console.log('  - debug24hWindow()           Diagnostica janela 24h da conversa atual');
console.log('  - debug24hWindow("+5531...")  Diagnostica conversa específica');
console.log('  - debugMessageOrder()        Verifica ordem das mensagens');

window.debugMissingMessages = async function() {
  const id = state.selectedId;
  if (!id) {
    console.error(' Nenhuma conversa selecionada');
    return;
  }
  
  console.log(`[EMJ] Verificando mensagens faltantes na conversa ${id}...`);
  
  try {
    // Pega até 100 mensagens da API
    const response = await api(`/api/admin/conversations/${encodeURIComponent(id)}/messages?limit=100`);
    const apiMessages = response.items || [];
    
    console.log(`[EMJ] API retornou ${apiMessages.length} mensagens`);
    
    // Pega mensagens do DOM
    const domBubbles = Array.from(els.chatBody.querySelectorAll('.bubble'));
    const domIds = new Set(domBubbles.map(b => b.dataset.messageId));
    
    console.log(`[EMJ] DOM tem ${domBubbles.length} mensagens`);
    
    // Encontra mensagens que estão na API mas não no DOM
    const missing = apiMessages.filter(m => !domIds.has(m.message_id));
    
    if (missing.length === 0) {
      console.log(' Todas as mensagens da API estão no DOM!');
    } else {
      console.error(` ${missing.length} mensagens faltando no DOM:`);
      missing.forEach((m, i) => {
        console.error(`  [${i}] ${m.ts} [${m.direction}] ${m.text?.substring(0, 50)}`);
      });
    }
    
    return { apiTotal: apiMessages.length, domTotal: domBubbles.length, missing };
  } catch (e) {
    console.error('Erro ao verificar mensagens:', e);
  }
};

// ====== API ======
async function api(path, {method='GET', body=null}={}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  
  let res;
  try {
    res = await fetch(path, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined, 
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow'
    });
  } catch (e) {
    setConnDot(false);
    throw new Error(`Falha de rede: ${e.message || e}`);
  }

  if (res.status === 401) {
    setConnDot(false);
    window.location.href = '/login';
    throw new Error('Não autorizado. Redirecionando para login...');
  }

  if (res.status === 429) {
    let retryAfter = res.headers.get('Retry-After');
    try {
      const j = await res.json();
      if (!retryAfter && j?.error?.retry_after_ms) {
        retryAfter = Math.ceil(j.error.retry_after_ms / 1000);
      }
    } catch {}
    throw new Error(`Muitas requisições. Tente novamente${retryAfter ? ` em ~${retryAfter}s` : ''}.`);
  }

  if (!res.ok) {
    let errTxt = ''; 
    try { errTxt = await res.text(); } catch {}
    throw new Error(`API ${method} ${path} -> ${res.status}: ${errTxt}`);
  }
  return res.json();
}

// ====== User Profile ======
async function loadUserProfile() {
  try {
    const j = await api('/api/user/profile');
    state.username = j.username || '';
    state.displayName = j.display_name || '';
    state.usePrefix = j.use_prefix || false;
    
    localStorage.setItem('crm_display_name', state.displayName);
    localStorage.setItem('crm_use_prefix', state.usePrefix);
    
    if (!state.displayName) {
      els.cfgUsername.textContent = state.username;
      els.cfgDisplayName.value = '';
      els.cfgUsePrefixToggle.checked = false;
      updateToggleVisibility();
      els.ovl.classList.add('show');
      return false;
    }
    return true;
  } catch (e) {
    console.error('Erro ao carregar perfil:', e);
    toast('Erro ao carregar perfil do usuário');
    return false;
  }
}

async function saveUserProfile() {
  const displayName = els.cfgDisplayName.value.trim();
  const usePrefix = els.cfgUsePrefixToggle.checked;
  
  if (!displayName) {
    toast('Nome de exibição é obrigatório');
    return;
  }
  
  try {
    await api('/api/user/profile', {
      method: 'POST',
      body: { 
        display_name: displayName,
        use_prefix: usePrefix
      }
    });
    
    state.displayName = displayName;
    state.usePrefix = usePrefix;
    localStorage.setItem('crm_display_name', displayName);
    localStorage.setItem('crm_use_prefix', usePrefix);
    
    els.ovl.classList.remove('show');
    toast('Configurações salvas!');
    
    await loadAllData();
  } catch (e) {
    toast('Erro ao salvar: ' + e.message);
  }
}

// ====== Tabs Management ======
function switchTab(tabName) {
  state.currentTab = tabName;
  
  // Update tab buttons
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.remove('active');
    if (tab.dataset.tab === tabName) {
      tab.classList.add('active');
    }
  });
  
  // Update title
  const titles = {
    bot: 'Atendente Val',
    pending: 'Fila Pendentes',
    claimed: 'Atendente Humano',
    resolved: 'Conversas Resolvidas'
  };
  els.listTitle.textContent = titles[tabName] || 'Conversas';
  
  // Render list
  renderConversationList();
}

function updatePendingAlert() {
  const count = state.conversations.pending.length;
  if (count > 0) {
    els.tabPending.classList.add('alert');
  } else {
    els.tabPending.classList.remove('alert');
  }
}

// ====== Conversations ======
async function loadBot(append = false) {
  try {
    let url = '/api/admin/conversations?status=bot&limit=50';
    if (append && state.conversationCursors.bot) {
      url += `&cursor=${encodeURIComponent(state.conversationCursors.bot)}`;
    }
    
    const j = await api(url);
    const items = j.items || [];
    
    if (append) {
      state.conversations.bot = [...state.conversations.bot, ...items];
    } else {
      state.conversations.bot = items;
    }
    
    state.conversationCursors.bot = j.next_cursor || null;
    state.hasMoreConversations.bot = !!j.next_cursor;
    
    if (state.currentTab === 'bot') renderConversationList(append);
  } catch(e) {
    console.error('Erro ao carregar bot:', e);
  }
}

async function loadPending(append = false) {
  try {
    const prevCount = state.lastPendingCount;
    
    let url = '/api/admin/conversations?status=pending_handoff&limit=50';
    if (append && state.conversationCursors.pending) {
      url += `&cursor=${encodeURIComponent(state.conversationCursors.pending)}`;
    }
    
    const j = await api(url);
    const items = j.items || [];
    
    if (append) {
      state.conversations.pending = [...state.conversations.pending, ...items];
    } else {
      state.conversations.pending = items;
    }
    
    state.conversationCursors.pending = j.next_cursor || null;
    state.hasMoreConversations.pending = !!j.next_cursor;
    
    state.lastPendingCount = state.conversations.pending.length;
    
    updatePendingAlert();
    
    if (!append && state.lastPendingCount > prevCount && !state.isPageVisible) {
      showDesktopNotification('Nova conversa pendente!', `${state.lastPendingCount} conversa(s) aguardando atendimento`);
    }
    
    if (state.currentTab === 'pending') renderConversationList(append);
  } catch(e) {
    console.error('Erro ao carregar pending:', e);
  }
}

async function loadClaimed(append = false) {
  try {
    let url = '/api/admin/conversations?mine=true&status=claimed,active&limit=50';
    if (append && state.conversationCursors.claimed) {
      url += `&cursor=${encodeURIComponent(state.conversationCursors.claimed)}`;
    }
    
    const j = await api(url);
    const items = j.items || [];
    
    if (append) {
      state.conversations.claimed = [...state.conversations.claimed, ...items];
    } else {
      state.conversations.claimed = items;
    }
    
    state.conversationCursors.claimed = j.next_cursor || null;
    state.hasMoreConversations.claimed = !!j.next_cursor;
    
    if (state.currentTab === 'claimed') renderConversationList(append);
  } catch(e) {
    console.error('Erro ao carregar claimed:', e);
  }
}

async function loadResolved(append = false) {
  try {
    // Para resolved, fazemos apenas quando o usuário acessar a aba
    if (state.currentTab === 'resolved') {
      let url = '/api/admin/conversations?status=resolved&limit=100';
      if (append && state.conversationCursors.resolved) {
        url += `&cursor=${encodeURIComponent(state.conversationCursors.resolved)}`;
      }
      
      const j = await api(url);
      const items = j.items || [];
      
      if (append) {
        state.conversations.resolved = [...state.conversations.resolved, ...items];
      } else {
        state.conversations.resolved = items;
      }
      
      state.conversationCursors.resolved = j.next_cursor || null;
      state.hasMoreConversations.resolved = !!j.next_cursor;
      
      renderConversationList(append);
    }
  } catch(e) {
    console.error('Erro ao carregar resolved:', e);
  }
}

// ====== Render Conversation List ======
function renderConversationList(append = false) {
  const conversations = state.conversations[state.currentTab] || [];
  
  if (!append) {
    els.convList.innerHTML = '';
  }
  
  if (conversations.length === 0 && !append) {
    els.convList.innerHTML = '<div class="empty-state">Nenhuma conversa nesta categoria</div>';
    return;
  }
  
  // Se append, remove empty state se existir
  if (append) {
    const emptyState = els.convList.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
  }
  
  // Se append, renderiza apenas novas conversas
  const startIndex = append ? els.convList.children.length : 0;
  const conversationsToRender = append ? conversations.slice(startIndex) : conversations;
  
  conversationsToRender.forEach(conv => {
    const div = document.createElement('div');
    div.className = 'conv-item';
    if (conv.conversation_id === state.selectedId) {
      div.classList.add('selected');
    }
    
    const statusClass = conv.status === 'pending_handoff' ? 'pending' : conv.status;
    const initials = getAvatarInitials(conv.conversation_id);
    const avatarBg = getAvatarColor(conv.conversation_id);
    
    // Exibe nome do cliente se disponivel, senao mostra o numero
    const displayName = conv.user_name || conv.conversation_id;
    const phoneDisplay = conv.user_name 
      ? `<span class="conv-phone-secondary">${escapeHtml(conv.conversation_id)}</span>`
      : '';
    
    div.innerHTML = `
      <div class="avatar" style="background:${avatarBg}">
        ${initials}
      </div>
      <div class="conv-content">
        <div class="conv-header">
          <span class="conv-phone">${escapeHtml(displayName)}</span>
          <span class="conv-status ${statusClass}">${getStatusLabel(conv.status)}</span>
        </div>
        ${phoneDisplay}
        <div class="conv-preview">${escapeHtml(conv.last_message_text || 'Sem mensagens')}</div>
        <div class="conv-time">${fmt(conv.updated_at)}</div>
      </div>
    `;
    
    div.onclick = () => openConversation(conv.conversation_id);
    els.convList.appendChild(div);
  });
}

// ====== Messages ======
async function loadMessages(id) {
  state.messageCursor = null;
  state.hasMoreMessages = true;
  state.isLoadingMessages = false;
  
  try {
    // Aumenta para 50 mensagens iniciais (ao invés de 25)
    const j = await api(`/api/admin/conversations/${encodeURIComponent(id)}/messages?limit=50`);
    const messages = j.items || [];
    
    console.log(`[EMJ] Carregando conversa ${id}: ${messages.length} mensagens recebidas da API`);
    
    state.messageCursor = j.next_cursor || null;
    state.hasMoreMessages = !!j.next_cursor;
    
    renderChat(id, messages);
    
    if (!state.hasMoreMessages && messages.length > 0) {
      console.log(' Todas as mensagens foram carregadas');
    }
  } catch (e) {
    console.error('Erro ao carregar mensagens:', e);
    toast('Erro ao carregar mensagens: ' + e.message);
  }
}

async function loadMoreMessages(id) {
  if (!state.hasMoreMessages || state.isLoadingMessages || !state.messageCursor) return;
  
  state.isLoadingMessages = true;
  showLoadingIndicator();
  
  try {
    const url = `/api/admin/conversations/${encodeURIComponent(id)}/messages?limit=25&cursor=${encodeURIComponent(state.messageCursor)}`;
    const j = await api(url);
    const messages = j.items || [];
    
    state.messageCursor = j.next_cursor || null;
    state.hasMoreMessages = !!j.next_cursor;
    
    if (messages.length > 0) {
      // snapshot do que já está no DOM
      const currentBubbles = Array.from(els.chatBody.querySelectorAll('.bubble'));
      const currentMessages = currentBubbles.map(bubble => ({
        message_id: bubble.dataset.messageId,
        ts: bubble.dataset.timestamp,
        direction: bubble.classList.contains('me') ? 'out' : 'in',
        text: bubble.dataset.text || '',
        element: bubble.parentElement // wrapper da bolha
      }));
      
      // guarda posição antes de re-render
      const oldScrollHeight = els.chatBody.scrollHeight;
      const oldScrollTop = els.chatBody.scrollTop;
      
      // merge + dedupe (chave = message_id; fallback em ts|direction|text)
      const byKey = new Map();
      const push = (m) => {
        const key = m.message_id || `${new Date(m.ts).getTime()}|${m.direction || ''}|${m.text || ''}`;
        if (!byKey.has(key)) {
          byKey.set(key, m);
        } else {
          // se já existe, preferimos o que já tem elemento do DOM (para não recriar)
          const prev = byKey.get(key);
          if (!prev.element && m.element) byKey.set(key, m);
        }
      };
      
      currentMessages.forEach(push);
      messages.forEach(push);
      
      const unique = Array.from(byKey.values()).sort(cmpMsg);
      
      // limpa (preserva indicador de loading)
      const loadingIndicator = document.getElementById('loadingIndicator');
      Array.from(els.chatBody.children).forEach(child => {
        if (child !== loadingIndicator) child.remove();
      });
      
      // re-render estável
      unique.forEach(m => {
        if (m.element) {
          els.chatBody.appendChild(m.element);
        } else {
          // passamos prepend=true só para garantir que não auto-scrolle
          addMessageBubble(m, true);
        }
      });
      
      // mantém a posição relativa do scroll
      const newScrollHeight = els.chatBody.scrollHeight;
      els.chatBody.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
      
      console.log(`[EMJ] Carregadas ${messages.length} antigas (únicas no DOM: ${unique.length})`);
    }
    
    if (!state.hasMoreMessages) {
      console.log(' Todas as mensagens antigas foram carregadas');
    }
  } catch (e) {
    console.error('Erro ao carregar mais mensagens:', e);
    toast('Erro ao carregar mais mensagens: ' + e.message);
  } finally {
    state.isLoadingMessages = false;
    hideLoadingIndicator();
  }
}

function setupInfiniteScroll() {
  els.chatBody.addEventListener('scroll', () => {
    if (state.scrollDebounceTimer) clearTimeout(state.scrollDebounceTimer);
    
    state.scrollDebounceTimer = setTimeout(() => {
      if (els.chatBody.scrollTop < 100 && state.hasMoreMessages && !state.isLoadingMessages) {
        const id = state.selectedId;
        if (id) loadMoreMessages(id);
      }
    }, 150);
  });
}

function setupConversationScroll() {
  els.convList.addEventListener('scroll', () => {
    if (state.convScrollDebounceTimer) clearTimeout(state.convScrollDebounceTimer);
    
    state.convScrollDebounceTimer = setTimeout(() => {
      const scrollTop = els.convList.scrollTop;
      const scrollHeight = els.convList.scrollHeight;
      const clientHeight = els.convList.clientHeight;
      
      // Verifica se chegou perto do final (100px do fim)
      if (scrollHeight - scrollTop - clientHeight < 100 && 
          state.hasMoreConversations[state.currentTab] && 
          !state.isLoadingConversations) {
        loadMoreConversations();
      }
    }, 150);
  });
}

async function loadMoreConversations() {
  if (state.isLoadingConversations || !state.hasMoreConversations[state.currentTab]) return;
  
  state.isLoadingConversations = true;
  
  // Adiciona indicador de loading
  const loadingDiv = document.createElement('div');
  loadingDiv.id = 'convLoadingIndicator';
  loadingDiv.style.cssText = `
    text-align: center;
    padding: 12px;
    color: var(--txt-sec);
    font-size: 12px;
  `;
  loadingDiv.textContent = ' Carregando mais conversas...';
  els.convList.appendChild(loadingDiv);
  
  try {
    console.log(`[EMJ] Carregando mais conversas da aba ${state.currentTab}...`);
    
    // Chama função de load correspondente com append=true
    if (state.currentTab === 'bot') {
      await loadBot(true);
    } else if (state.currentTab === 'pending') {
      await loadPending(true);
    } else if (state.currentTab === 'claimed') {
      await loadClaimed(true);
    } else if (state.currentTab === 'resolved') {
      await loadResolved(true);
    }
    
    if (!state.hasMoreConversations[state.currentTab]) {
      console.log(' Todas as conversas foram carregadas');
    }
  } catch (e) {
    console.error('Erro ao carregar mais conversas:', e);
  } finally {
    state.isLoadingConversations = false;
    // Remove indicador de loading
    const indicator = document.getElementById('convLoadingIndicator');
    if (indicator) indicator.remove();
  }
}

function renderChat(id, messages) {
  state.selectedId = id;
  els.chatId.textContent = id;
  els.chatBody.innerHTML = '';
  
  console.log(`[EMJ] Renderizando chat ${id}:`, {
    totalMensagens: messages.length,
    primeiraMsg: messages[0]?.ts,
    ultimaMsg: messages[messages.length - 1]?.ts
  });
  
  // SEMPRE ordena por timestamp com desempate determinístico
  const sortedMessages = messages.sort(cmpMsg);
  
  console.log(`[EMJ] Após ordenação:`, {
    primeiraMsg: sortedMessages[0]?.ts,
    ultimaMsg: sortedMessages[sortedMessages.length - 1]?.ts
  });
  
  // Renderiza na ordem correta
  sortedMessages.forEach(m => addMessageBubble(m, false));
  
  console.log(` Chat renderizado: ${sortedMessages.length} mensagens`);
  
  // Força scroll para o final
  setTimeout(() => {
    els.chatBody.scrollTop = els.chatBody.scrollHeight;
    console.log(`[EMJ] Scroll final: ${els.chatBody.scrollTop}/${els.chatBody.scrollHeight}`);
  }, 100);
  
  renderConversationList();
  startConvPolling(id);
}

// Escolhe a URL mais segura para exibir mídia no navegador.
// Ordem: GCS/assinado -> proxy backend -> (fallback) URL direta
function getSafeMediaUrl(m, a) {
  const direct = a.gcs_url || a.signed_url || a.url;
  // Se já é GCS/assinado ou não é Twilio API, pode usar direto
  if (direct && !/api\.twilio\.com\/2010-04-01\//.test(direct)) {
    return direct;
  }
  // Se for mídia do Twilio (ou não sabemos), preferimos SEMPRE o proxy
  if (m?.message_id && state.selectedId) {
    return `/api/admin/media/${encodeURIComponent(state.selectedId)}/${encodeURIComponent(m.message_id)}`;
  }
  // Último recurso: usar a URL direta (pode pedir auth do Twilio)
  return direct || '';
}

// Helper: renderiza anexos (inclui OGG/Opus do Twilio)
function renderMediaIntoBubble(m, bubble) {
  const attachments = [];
  // Vários formatos possíveis vindos da sua API
  if (Array.isArray(m.media)) attachments.push(...m.media);                // [{url, content_type, ...}]
  if (Array.isArray(m.media_urls)) attachments.push(...m.media_urls.map(u => ({url: u})));
  if (m.media_url) attachments.push({ url: m.media_url, content_type: m.media_type || m.mime });
  if (m.url && (m.mime || m.content_type)) attachments.push({ url: m.url, content_type: m.mime || m.content_type });
  if (!attachments.length) return;
  const box = document.createElement('div');
  box.className = 'attachments';
  for (const a of attachments) {
    const url = getSafeMediaUrl(m, a);
    if (!url) continue;
    const ctRaw = (a.content_type || a.mime || '').toLowerCase();
    const ct = ctRaw.split(';')[0].trim();
    const isOggExt = /\.ogg(\?.*)?$/i.test(url);
    const isAudioByCT = ct.startsWith('audio/') || ct === 'application/ogg';
    if (isAudioByCT || isOggExt || /\.mp3(\?.*)?$/i.test(url) || /\.wav(\?.*)?$/i.test(url)) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.style.display = 'block';
      audio.style.marginTop = '6px';
      // Fonte principal
      const src = document.createElement('source');
      src.src = url;
      // Normaliza application/ogg -> audio/ogg para ajudar o Chrome
      src.type = (ct === 'application/ogg' || !ct) ? 'audio/ogg' : ct;
      audio.appendChild(src);
      // Mensagem de fallback
      audio.appendChild(document.createTextNode('Seu navegador não conseguiu reproduzir este áudio.'));
      box.appendChild(audio);
      continue;
    }
    if (ct.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(url)) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Anexo';
      img.style.maxWidth = '260px';
      img.style.borderRadius = '8px';
      img.style.display = 'block';
      img.style.marginTop = '6px';
      box.appendChild(img);
      continue;
    }
    // Fallback genérico: link
    const aTag = document.createElement('a');
    aTag.href = url;
    aTag.target = '_blank';
    aTag.rel = 'noopener';
    aTag.textContent = 'Abrir anexo';
    aTag.style.display = 'inline-block';
    aTag.style.marginTop = '6px';
    box.appendChild(aTag);
  }
  bubble.appendChild(box);
}

function addMessageBubble(m, prepend=false) {
  const isOut = m.direction === 'out';
  const bubble = document.createElement('div');
  bubble.className = 'bubble ' + (isOut ? 'me' : 'other');
  bubble.dataset.messageId = m.message_id;
  bubble.dataset.timestamp = m.ts;
  bubble.dataset.text = m.text || ''; // para dedupe estável
  bubble.textContent = m.text || '';
  
  const meta = document.createElement('div');
  meta.className = 'meta';
  const displayName = m.display_name || (isOut ? state.displayName : 'Cliente');
  meta.textContent = `${displayName}  ${fmt(m.ts)}`;
  
  const wrap = document.createElement('div');
  wrap.style.cssText = isOut ? 'display:flex;justify-content:flex-end' : '';
  wrap.appendChild(bubble);
  bubble.appendChild(meta);
  
  // NOVO: renderiza áudio/imagem/anexos (inclui OGG do Twilio)
  renderMediaIntoBubble(m, bubble);
  
  // Sempre adiciona no final (já ordenamos antes de chamar)
  els.chatBody.appendChild(wrap);
  
  // Auto-scroll apenas se não estiver carregando mensagens antigas
  if (!state.isLoadingMessages && !prepend) {
    els.chatBody.scrollTop = els.chatBody.scrollHeight;
  }
}

async function refreshMessages(id) {
  if (!id || id !== state.selectedId) return;
  if (state.isLoadingMessages) return; // evita corrida durante o loadMore

  try {
    const j = await api(`/api/admin/conversations/${encodeURIComponent(id)}/messages?limit=50`);
    const apiMsgs = j.items || [];

    // Snapshot do DOM atual
    const domBubbles = Array.from(els.chatBody.querySelectorAll('.bubble'));
    const domMsgs = domBubbles.map(b => ({
      message_id: b.dataset.messageId,
      ts: b.dataset.timestamp,
      direction: b.classList.contains('me') ? 'out' : 'in',
      text: b.dataset.text || '',
      element: b.parentElement
    }));

    // Substitui IDs temporários se a API devolver o definitivo
    if (apiMsgs.length) {
      for (const m of apiMsgs) {
        if (m.client_request_id) {
          const tempId = 'temp:' + m.client_request_id;
          const bubble = domBubbles.find(b => b.dataset.messageId === tempId);
          if (bubble) {
            bubble.dataset.messageId = m.message_id;
            console.log(`[EMJ] ID temporário ${tempId} substituído por ${m.message_id}`);
          }
        }
      }
    }

    // Merge + dedupe (preferindo nós já presentes no DOM)
    const byKey = new Map();
    const push = (m) => {
      const key = m.message_id || `${new Date(m.ts).getTime()}|${m.direction || ''}|${m.text || ''}`;
      if (!byKey.has(key)) byKey.set(key, m);
      else {
        const prev = byKey.get(key);
        if (!prev.element && m.element) byKey.set(key, m);
      }
    };

    domMsgs.forEach(push);
    apiMsgs.forEach(push);

    const unique = Array.from(byKey.values()).sort(cmpMsg);

    // Conta mensagens novas (que não existiam no DOM)
    const domIds = new Set(domMsgs.map(m => m.message_id));
    const newMessages = apiMsgs.filter(m => !domIds.has(m.message_id));
    
    // Se há mensagens novas, rebuild
    if (newMessages.length > 0) {
      console.log(`[EMJ] ${newMessages.length} nova(s) mensagem(ns) recebida(s)`);
      
      // Verifica se tem mensagem do cliente
      const hasClientMessage = newMessages.some(m => m.direction === 'in');

      // Preserva posição do scroll
      const atBottom = (els.chatBody.scrollHeight - els.chatBody.scrollTop - els.chatBody.clientHeight) < 20;
      const oldScrollHeight = els.chatBody.scrollHeight;
      const oldScrollTop = els.chatBody.scrollTop;

      // Limpa e re-render (sem o indicador)
      const loadingIndicator = document.getElementById('loadingIndicator');
      Array.from(els.chatBody.children).forEach(child => {
        if (child !== loadingIndicator) child.remove();
      });

      unique.forEach(m => {
        if (m.element) {
          els.chatBody.appendChild(m.element);
        } else {
          // não auto-scrollar durante refresh
          addMessageBubble(m, true);
        }
      });

      // Ajuste de scroll
      if (atBottom) {
        els.chatBody.scrollTop = els.chatBody.scrollHeight;
      } else {
        const newScrollHeight = els.chatBody.scrollHeight;
        els.chatBody.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
      }
      
      // [EMJ] NOVA LOGICA: Se recebeu mensagem do cliente, recheca janela 24h
      if (hasClientMessage && state.outside24hWindow) {
        console.log('[EMJ] Mensagem do cliente recebida - rechecando janela 24h');
        await check24hWindow(id);
      }
      
      // Notificação visual se for mensagem do cliente
      if (hasClientMessage && !state.isPageVisible) {
        const conv = [...state.conversations.bot, ...state.conversations.pending, ...state.conversations.claimed]
          .find(c => c.conversation_id === id);
        if (conv) {
          showDesktopNotification(
            'Nova mensagem!',
            `De ${id}: ${newMessages[0].text?.substring(0, 50) || '...'}`
          );
        }
      }
      
      // Toast visual se estiver na aba mas scrollado
      if (hasClientMessage && !atBottom) {
        const indicator = document.createElement('div');
        indicator.style.cssText = `
          position: fixed;
          bottom: 80px;
          right: 50%;
          transform: translateX(50%);
          background: var(--acc);
          color: #06210f;
          padding: 8px 16px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          z-index: 1000;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        `;
        indicator.textContent = ' Nova mensagem';
        indicator.onclick = () => {
          els.chatBody.scrollTop = els.chatBody.scrollHeight;
          indicator.remove();
        };
        document.body.appendChild(indicator);
        setTimeout(() => indicator.remove(), 5000);
      }
    }
  } catch (e) {
    console.error('Erro ao atualizar mensagens:', e);
  }
}

// ====== Actions ======
async function claim(id) {
  try {
    await api(`/api/admin/conversations/${encodeURIComponent(id)}/claim`, {method:'POST'});
    toast(' Conversa assumida: ' + id);
    await Promise.all([loadPending(), loadClaimed(), loadBot()]);
    openConversation(id);
  } catch(e) { 
    toast(' Erro ao assumir: ' + e.message); 
  }
}

async function handoffFromBot(id) {
  try {
    await api(`/api/admin/conversations/${encodeURIComponent(id)}/handoff`, {method:'POST'});
    toast(' Conversa assumida do bot: ' + id);
    await Promise.all([loadPending(), loadClaimed(), loadBot()]);
    openConversation(id);
  } catch(e) { 
    toast(' Erro ao assumir do bot: ' + e.message); 
  }
}

async function resolve() {
  const id = state.selectedId; 
  if(!id) return;
  try {
    await api(`/api/admin/conversations/${encodeURIComponent(id)}/resolve`, {method:'POST'});
    toast('Encerrada: ' + id);
    await Promise.all([loadPending(), loadClaimed(), loadBot()]);
    renderChat('', []);
  } catch(e) { 
    toast('Erro ao encerrar: ' + e.message); 
  }
}

async function send() {
  const id = state.selectedId; 
  if(!id) return;
  const txt = els.inpMsg.value.trim(); 
  if(!txt || state.sending) return;
  
  state.sending = true; 
  els.btnSend.disabled = true;
  const rid = (crypto.randomUUID && crypto.randomUUID()) || (Date.now() + "-" + Math.random().toString(16).slice(2));
  
  try {
    const j = await api(`/api/admin/conversations/${encodeURIComponent(id)}/send`, {
      method: 'POST', 
      body: {text: txt, client_request_id: rid}
    });
    els.inpMsg.value = '';
    
    const m = j.message || {
      message_id: 'temp:' + rid, // ID temporário visível no DOM
      text: txt, 
      display_name: state.displayName,
      direction: 'out', 
      ts: new Date().toISOString()
    };
    
    // Verifica se já existe uma bolha com este temp ID (evita duplicata otimista)
    const existingBubbles = Array.from(els.chatBody.querySelectorAll('.bubble'));
    const alreadyExists = existingBubbles.some(bubble => 
      bubble.dataset.messageId === m.message_id || 
      bubble.dataset.messageId === j.message?.message_id
    );
    
    if (!alreadyExists) {
      addMessageBubble(m, false);
    } else {
      console.log('  Mensagem já existe no DOM, ignorando duplicata');
    }
    
    await loadClaimed();
  } catch(e) { 
    toast('Falha ao enviar: ' + e.message); 
  } finally { 
    state.sending = false; 
    setTimeout(() => {els.btnSend.disabled = false}, 900); 
  }
}

async function openConversation(id) {
  try {
    const j = await api(`/api/admin/conversations/${encodeURIComponent(id)}`);
    const mine = (j.assignee === state.username);
    
    // Salva nome do cliente no estado
    state.selectedUserName = j.user_name || '';
    
    // Atualiza exibicao do nome no cabecalho
    updateCustomerNameDisplay(id, state.selectedUserName);
    
    // Botao Resolver - apenas para conversas ativas do proprio agente ou bot
    els.btnResolve.style.display = 
      (mine && (j.status === 'claimed' || j.status === 'active')) || j.status === 'bot' 
        ? 'inline-block' 
        : 'none';
    
    // Botao Assumir (Claim) - apenas para pending que nao sao do agente
    els.btnClaim.style.display = (!mine && j.status === 'pending_handoff') ? 'inline-block' : 'none';
    if (!mine && j.status === 'pending_handoff') {
      els.btnClaim.onclick = () => claim(id);
    }
    
    // Botao Handoff do Bot - apenas para conversas no bot
    els.btnHandoff.style.display = (j.status === 'bot') ? 'inline-block' : 'none';
    if (j.status === 'bot') {
      els.btnHandoff.onclick = () => handoffFromBot(id);
    }
    
    // Verifica janela de 24h (funciona para todos os status, incluindo resolved)
    await check24hWindow(id);
    
    await loadMessages(id);
  } catch(e) { 
    toast('Erro ao abrir conversa: ' + e.message); 
  }
}

// ====== Search ======
async function doSearch(query) {
  const q = query.trim();
  if (!q) {
    // Se vazio, volta para a aba atual
    renderConversationList();
    return;
  }
  
  // Busca em todas as conversas carregadas
  const allConvs = [
    ...state.conversations.bot,
    ...state.conversations.pending,
    ...state.conversations.claimed,
    ...state.conversations.resolved
  ];
  
  const filtered = allConvs.filter(conv => 
    conv.conversation_id.includes(q) || 
    (conv.last_message_text && conv.last_message_text.includes(q))
  );
  
  els.convList.innerHTML = '';
  if (filtered.length === 0) {
    // Tenta buscar direto na API
    try {
      const c = await api(`/api/admin/conversations/${encodeURIComponent(q)}`);
      const div = document.createElement('div');
      div.className = 'conv-item';
      const statusClass = c.status === 'pending_handoff' ? 'pending' : c.status;
      const initials = getAvatarInitials(c.conversation_id);
      const avatarBg = getAvatarColor(c.conversation_id);
      
      // Exibe nome do cliente se disponivel
      const displayName = c.user_name || c.conversation_id;
      const phoneDisplay = c.user_name 
        ? `<span class="conv-phone-secondary">${escapeHtml(c.conversation_id)}</span>`
        : '';
      
      div.innerHTML = `
        <div class="avatar" style="background:${avatarBg}">
          ${initials}
        </div>
        <div class="conv-content">
          <div class="conv-header">
            <span class="conv-phone">${escapeHtml(displayName)}</span>
            <span class="conv-status ${statusClass}">${getStatusLabel(c.status)}</span>
          </div>
          ${phoneDisplay}
          <div class="conv-preview">${escapeHtml(c.last_message_text || 'Sem mensagens')}</div>
          <div class="conv-time">${fmt(c.updated_at)}</div>
        </div>
      `;
      div.onclick = () => openConversation(c.conversation_id);
      els.convList.appendChild(div);
    } catch {
      els.convList.innerHTML = '<div class="empty-state">Nenhuma conversa encontrada</div>';
    }
    return;
  }
  
  // Mostra resultados filtrados
  filtered.forEach(conv => {
    const div = document.createElement('div');
    div.className = 'conv-item';
    if (conv.conversation_id === state.selectedId) {
      div.classList.add('selected');
    }
    
    const statusClass = conv.status === 'pending_handoff' ? 'pending' : conv.status;
    const initials = getAvatarInitials(conv.conversation_id);
    const avatarBg = getAvatarColor(conv.conversation_id);
    
    // Exibe nome do cliente se disponivel
    const displayName = conv.user_name || conv.conversation_id;
    const phoneDisplay = conv.user_name 
      ? `<span class="conv-phone-secondary">${escapeHtml(conv.conversation_id)}</span>`
      : '';
    
    div.innerHTML = `
      <div class="avatar" style="background:${avatarBg}">
        ${initials}
      </div>
      <div class="conv-content">
        <div class="conv-header">
          <span class="conv-phone">${escapeHtml(displayName)}</span>
          <span class="conv-status ${statusClass}">${getStatusLabel(conv.status)}</span>
        </div>
        ${phoneDisplay}
        <div class="conv-preview">${escapeHtml(conv.last_message_text || 'Sem mensagens')}</div>
        <div class="conv-time">${fmt(conv.updated_at)}</div>
      </div>
    `;
    
    div.onclick = () => openConversation(conv.conversation_id);
    els.convList.appendChild(div);
  });
}

// ====== Polling ======
function startNormalPolling() {
  stopAllPolling();
  console.log('[EMJ] Polling NORMAL ativado (10s)');
  setConnDot(true);
  loadAllData();
  state.pollingInterval = setInterval(loadAllData, 10000);
}

function startBackgroundPolling() {
  stopAllPolling();
  console.log('[EMJ] Polling em BACKGROUND (60s - pendentes)');
  setConnDot(true);
  state.backgroundPollingInterval = setInterval(async () => {
    try { await loadPending(); } 
    catch (e) { console.error('Background polling error:', e); setConnDot(false); }
  }, 60000);
}

function stopAllPolling() {
  if (state.pollingInterval) clearInterval(state.pollingInterval), state.pollingInterval = null;
  if (state.backgroundPollingInterval) clearInterval(state.backgroundPollingInterval), state.backgroundPollingInterval = null;
  stopConvPolling();
}

function stopConvPolling() {
  if (state.convPollingInterval) clearInterval(state.convPollingInterval), state.convPollingInterval = null;
}

async function loadAllData() {
  try {
    await Promise.all([loadBot(), loadPending(), loadClaimed()]);
    // Resolved só carrega quando o usuário acessar a aba
    if (state.currentTab === 'resolved') {
      await loadResolved();
    }
    setConnDot(true);
  } catch(e) {
    console.error('Polling error:', e);
    setConnDot(false);
  }
}

function startConvPolling(id) {
  stopConvPolling();
  console.log('[EMJ] Polling de conversa iniciado:', id, '(a cada 10s)');
  
  // NAO chama refreshMessages imediatamente - evita corrida com renderChat
  // O primeiro refresh será após 10 segundos
  
  // Polling a cada 10 segundos
  state.convPollingInterval = setInterval(async () => {
    if (state.selectedId === id) {
      console.log('[EMJ] Atualizando mensagens da conversa:', id);
      await refreshMessages(id);
    } else {
      console.log('  Conversa mudou, parando polling de:', id);
      stopConvPolling();
    }
  }, 10000);
}

// ====== Notifications ======
function showDesktopNotification(title, body) {
  if (Notification.permission === 'granted' && !state.isPageVisible) {
    try {
      const notification = new Notification(title, {
        body, icon: '/favicon.ico', badge: '/favicon.ico',
        tag: 'crm-notification', requireInteraction: false
      });
      notification.onclick = () => { window.focus(); notification.close(); };
      setTimeout(() => notification.close(), 5000);
    } catch (e) { console.warn('Erro ao notificar:', e); }
  }
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(p => {
      if (p === 'granted') console.log(' Notificações desktop ativadas');
    });
  }
}

// ====== Visibility ======
document.addEventListener('visibilitychange', () => {
  state.isPageVisible = !document.hidden;
  if (state.isPageVisible) {
    console.log('[EMJ] Aba VISIVEL - retomando polling normal');
    startNormalPolling();
    if (state.selectedId) {
      console.log('[EMJ] Retomando polling da conversa:', state.selectedId);
      startConvPolling(state.selectedId);
    }
  } else {
    console.log('[EMJ] Aba OCULTA - reduzindo polling');
    startBackgroundPolling();
    // Mantém polling de conversa ativa mesmo em background
    if (state.selectedId) {
      console.log('[EMJ] Mantendo polling da conversa em background:', state.selectedId);
      // Não para o convPolling - continua checando mensagens
    }
  }
});

window.addEventListener('online', () => {
  console.log('[EMJ] Online - retomando');
  setConnDot(true);
  startNormalPolling();
});

window.addEventListener('offline', () => {
  console.log('[EMJ] Offline');
  setConnDot(false);
  stopAllPolling();
});

// ====== Events ======
els.btnSend.onclick = send;
els.btnResolve.onclick = resolve;
els.btnReopen.onclick = reopenConversation;

els.inpMsg.addEventListener('keypress', (e) => { 
  if(e.key === 'Enter' && !e.shiftKey) { 
    e.preventDefault(); 
    send(); 
  } 
});

els.btnSettings.onclick = () => { 
  els.cfgUsername.textContent = state.username;
  els.cfgDisplayName.value = state.displayName;
  els.cfgUsePrefixToggle.checked = state.usePrefix;
  updateToggleVisibility();
  els.ovl.classList.add('show'); 
};

els.btnSaveCfg.onclick = saveUserProfile;

// Customer name edit events
els.btnEditName.onclick = openEditNameModal;
els.btnSaveCustomerName.onclick = saveCustomerName;
els.btnCancelEditName.onclick = closeEditNameModal;
els.inpCustomerName.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveCustomerName();
  }
});

els.cfgUsePrefixToggle.addEventListener('change', () => {
  state.usePrefix = els.cfgUsePrefixToggle.checked;
  updateToggleVisibility();
});

// Tab events
els.tabBot.onclick = () => switchTab('bot');
els.tabPending.onclick = () => switchTab('pending');
els.tabClaimed.onclick = () => switchTab('claimed');
els.tabResolved.onclick = () => {
  switchTab('resolved');
  loadResolved(); // Carrega apenas quando acessar
};

// Search event
els.inpSearch.addEventListener('input', (e) => {
  doSearch(e.target.value);
});

// ====== Bootstrap ======
async function bootstrap() {
  console.log('[FOGUETE] Iniciando CRM...');
  
  setupInfiniteScroll();
  setupConversationScroll();
  
  const hasProfile = await loadUserProfile();
  if (!hasProfile) {
    console.log('  Aguardando configuração de nome de exibição');
    return;
  }
  
  try { 
    await Promise.all([loadBot(), loadPending(), loadClaimed()]); 
    renderConversationList();
  } catch(e) { 
    console.error(' Erro ao carregar dados:', e);
    toast('Falha ao carregar: ' + e.message); 
  }
  
  requestNotificationPermission();
  if (document.hidden) startBackgroundPolling();
  else startNormalPolling();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}