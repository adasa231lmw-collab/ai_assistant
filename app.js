const state = {
  activeChatId: null,
  chats: [],
  memories: [],
  models: [],
  processes: [],
  ollamaAvailable: false,
  recommendedModel: 'qwen3:4b',
  news: [],
  newsLoadedAt: null,
  sending: false,
  toastTimer: null,
};

const byId = (id) => document.getElementById(id);
const chatList = byId('chat-list');
const messageList = byId('message-list');
const welcome = byId('welcome');
const input = byId('message-input');
const sendButton = byId('send-button');
const modelSelect = byId('model-select');
const contextSelect = byId('context-select');

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

async function streamChat(payload, onToken, onMemory, onTitle) {
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `Request failed (${response.status})`);
  }
  if (!response.body) throw new Error('This browser does not support streamed responses.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let conversationId = payload.conversation_id;
  let complete = false;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const eventName = block.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim();
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (data) {
        const event = JSON.parse(data);
        if (event.type === 'token') onToken(event.text || '');
        if (eventName === 'memory' && onMemory) onMemory(event);
        if (eventName === 'title' && onTitle) onTitle(event);
        if (event.type === 'error') throw new Error(event.error || 'The local model returned an error.');
        if (event.type === 'done') {
          conversationId = event.conversation_id || conversationId;
          complete = true;
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
  if (!complete) throw new Error('The response stream ended before Stony finished. The partial reply is still visible.');
  return { conversation_id: conversationId };
}

function notify(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 2800);
}

function setTitle(title) {
  byId('current-title').textContent = title || 'A little room to think';
}

function setChatPath(chatId, replace = false) {
  const path = chatId ? `/chat/${encodeURIComponent(chatId)}` : '/';
  if (window.location.pathname === path) return;
  window.history[replace ? 'replaceState' : 'pushState']({ chatId }, '', path);
}

function chatIdFromPath() {
  return window.location.pathname.match(/^\/chat\/([0-9a-f-]{36})$/i)?.[1] || null;
}

function renderChats() {
  chatList.replaceChildren();
  if (!state.chats.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-note';
    empty.textContent = 'Your conversations will live here.';
    chatList.append(empty);
    return;
  }
  for (const chat of state.chats) {
    const row = document.createElement('div');
    row.className = `chat-entry${chat.id === state.activeChatId ? ' active' : ''}`;
    const open = document.createElement('button');
    open.className = 'chat-entry';
    open.type = 'button';
    open.setAttribute('aria-label', `Open ${chat.title}`);
    const glyph = document.createElement('span');
    glyph.className = 'chat-entry-icon';
    glyph.textContent = '↳';
    const title = document.createElement('span');
    title.className = 'chat-entry-title';
    title.textContent = chat.title;
    open.append(glyph, title);
    open.addEventListener('click', () => loadChat(chat.id));
    const remove = document.createElement('button');
    remove.className = 'delete-chat';
    remove.type = 'button';
    remove.title = 'Delete conversation';
    remove.setAttribute('aria-label', `Delete ${chat.title}`);
    remove.textContent = '×';
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!confirm(`Delete “${chat.title}” and its messages from this PC?`)) return;
      try {
        await api(`/api/chats/${encodeURIComponent(chat.id)}`, { method: 'DELETE' });
        if (state.activeChatId === chat.id) startBlankChat();
        await loadChats();
        notify('Conversation deleted from this PC.');
      } catch (error) { notify(error.message); }
    });
    row.append(open, remove);
    chatList.append(row);
  }
}

async function loadChats() {
  state.chats = await api('/api/chats');
  renderChats();
}

function formatTime(value) {
  try { return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}

function renderRichReply(content) {
  const html = marked.parse(content, { gfm: true });
  const safeHtml = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_ATTR: ['style'],
    FORBID_TAGS: ['audio', 'embed', 'form', 'iframe', 'img', 'object', 'script', 'style', 'svg', 'video'],
  });
  const richText = document.createElement('div');
  richText.className = 'message-text rich-text';
  richText.innerHTML = safeHtml;
  for (const link of richText.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    if (/^(https?:\/\/|mailto:|#)/i.test(href)) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } else {
      link.removeAttribute('href');
    }
  }
  for (const pre of richText.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const languageClass = [...code.classList].find((name) => name.startsWith('language-'));
    const languageName = languageClass?.slice('language-'.length) || '';
    if (languageName && hljs.getLanguage(languageName)) {
      const highlighted = hljs.highlight(code.textContent || '', { language: languageName, ignoreIllegals: true }).value;
      code.innerHTML = DOMPurify.sanitize(highlighted, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] });
    }
    code.classList.add('hljs');
    const toolbar = document.createElement('div');
    toolbar.className = 'code-toolbar';
    const language = document.createElement('span');
    language.textContent = languageName || 'CODE';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent || '');
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
      } catch { notify('Clipboard access is unavailable in this browser.'); }
    });
    toolbar.append(language, copy);
    pre.before(toolbar);
  }
  return richText;
}

function renderMessage(message) {
  const article = document.createElement('article');
  article.className = `message ${message.role}`;
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = message.role === 'assistant' ? 's' : 'Y';
  const body = document.createElement('div');
  body.className = 'message-body';
  const head = document.createElement('div');
  head.className = 'message-head';
  const name = document.createElement('strong');
  name.textContent = message.role === 'assistant' ? 'Stony' : 'You';
  const time = document.createElement('time');
  time.textContent = formatTime(message.created_at);
  head.append(name, time);
  const text = message.role === 'assistant' ? renderRichReply(message.content || '') : document.createElement('p');
  text.classList.add('message-text');
  if (message.role !== 'assistant') text.textContent = message.content;
  body.append(head, text);
  if (message.role === 'assistant' || message.role === 'user') {
    const tools = document.createElement('div');
    tools.className = 'message-tools';
    const remember = document.createElement('button');
    remember.type = 'button';
    remember.textContent = 'Save to memory';
    remember.addEventListener('click', () => addMemory(message.content));
    tools.append(remember);
    body.append(tools);
  }
  article.append(avatar, body);
  return article;
}

function showMessages(messages) {
  messageList.replaceChildren(...messages.map(renderMessage));
  welcome.hidden = messages.length > 0;
  byId('conversation').scrollTop = byId('conversation').scrollHeight;
}

async function loadChat(chatId, { updateUrl = true } = {}) {
  try {
    const [chat, messages] = await Promise.all([
      api('/api/chats').then((chats) => chats.find((item) => item.id === chatId)),
      api(`/api/chats/${encodeURIComponent(chatId)}`),
    ]);
    state.activeChatId = chatId;
    if (updateUrl) setChatPath(chatId);
    setTitle(chat?.title || 'Conversation');
    showMessages(messages);
    renderChats();
    closeMobilePanels();
  } catch (error) { notify(error.message); }
}

function startBlankChat({ updateUrl = true } = {}) {
  state.activeChatId = null;
  if (updateUrl) setChatPath(null);
  setTitle('A little room to think');
  showMessages([]);
  renderChats();
  input.focus();
  closeMobilePanels();
}

async function createChat() {
  const chat = await api('/api/chats', { method: 'POST', body: '{}' });
  state.activeChatId = chat.id;
  setChatPath(chat.id);
  setTitle('New conversation');
  await loadChats();
  return chat.id;
}

async function sendMessage(text) {
  if (state.sending || !text.trim()) return;
  state.sending = true;
  sendButton.disabled = true;
  input.disabled = true;
  welcome.hidden = true;
  const now = new Date().toISOString();
  messageList.append(renderMessage({ role: 'user', content: text.trim(), created_at: now }));
  const waiting = document.createElement('article');
  waiting.className = 'message';
  waiting.id = 'waiting-message';
  waiting.innerHTML = '<div class="message-avatar" aria-hidden="true">s</div><div class="message-body"><p class="typing">Stony is thinking…</p></div>';
  messageList.append(waiting);
  byId('conversation').scrollTop = byId('conversation').scrollHeight;
  input.value = '';
  input.style.height = '';
  let streamedMessage = null;
  let streamedRecord = null;
  let renderScheduled = false;
  let memoryNotice = null;
  try {
    if (!state.activeChatId) await createChat();
    const result = await streamChat({
        conversation_id: state.activeChatId,
        message: text.trim(),
        model: modelSelect.value,
        context_size: Number(contextSelect.value),
        reasoning_summary: byId('rationale-toggle').checked,
        auto_save_memory: byId('auto-memory-toggle').checked,
        news: byId('include-news').checked ? state.news : [],
        processes: byId('include-processes').checked ? state.processes : [],
      }, (token) => {
        if (!streamedMessage) {
          waiting.remove();
          streamedRecord = { role: 'assistant', content: '', created_at: new Date().toISOString() };
          streamedMessage = renderMessage(streamedRecord);
          streamedMessage.classList.add('is-streaming');
          messageList.append(streamedMessage);
        }
        streamedRecord.content += token;
        if (!renderScheduled) {
          renderScheduled = true;
          requestAnimationFrame(() => {
            renderScheduled = false;
            streamedMessage.querySelector('.message-text').replaceWith(renderRichReply(streamedRecord.content));
            byId('conversation').scrollTop = byId('conversation').scrollHeight;
          });
        }
        byId('conversation').scrollTop = byId('conversation').scrollHeight;
      }, (memory) => {
        if (!memoryNotice) {
          memoryNotice = document.createElement('div');
          memoryNotice.className = 'memory-event';
          memoryNotice.setAttribute('role', 'status');
          messageList.insertBefore(memoryNotice, waiting);
        }
        if (memory.action === 'saved') {
          memoryNotice.className = 'memory-event memory-event-saved';
          memoryNotice.textContent = memory.added
            ? `Saved to long-term memory: ${memory.content}`
            : `Already in long-term memory: ${memory.content}`;
          if (memory.added) loadMemories().catch((error) => notify(error.message));
        } else if (memory.action === 'forgotten') {
          memoryNotice.className = 'memory-event memory-event-forgotten';
          memoryNotice.textContent = memory.count
            ? `Memory updated: forgot ${memory.count} saved detail${memory.count === 1 ? '' : 's'}.`
            : 'Memory checked: no matching saved detail was found.';
          loadMemories().catch((error) => notify(error.message));
        } else if (memory.action === 'skipped') {
          const messages = {
            user: 'Okay, I did not save that.',
            transient: 'I treated that as temporary, so I did not save it.',
            vague: 'That did not sound like a lasting preference, so I left it out of memory.',
            sensitive: 'I do not save passwords or sensitive details automatically.',
          };
          memoryNotice.className = 'memory-event memory-event-skipped';
          memoryNotice.textContent = messages[memory.reason] || 'Not saved to long-term memory.';
        }
        byId('conversation').scrollTop = byId('conversation').scrollHeight;
      }, (titleEvent) => {
        if (!titleEvent.title) return;
        setTitle(titleEvent.title);
        const chat = state.chats.find((item) => item.id === state.activeChatId);
        if (chat) {
          chat.title = titleEvent.title;
          renderChats();
        }
      });
    if (!streamedMessage) {
      waiting.remove();
      streamedMessage = renderMessage({ role: 'assistant', content: '', created_at: new Date().toISOString() });
      messageList.append(streamedMessage);
    }
    if (streamedRecord) streamedMessage.querySelector('.message-text').replaceWith(renderRichReply(streamedRecord.content));
    await loadChats();
    const active = state.chats.find((chat) => chat.id === state.activeChatId);
    setTitle(active?.title || 'Conversation');
  } catch (error) {
    waiting.remove();
    const problem = renderMessage({ role: 'assistant', content: `I couldn't answer that yet. ${error.message}`, created_at: new Date().toISOString() });
    problem.classList.add('error-message');
    messageList.append(problem);
  } finally {
    streamedMessage?.classList.remove('is-streaming');
    state.sending = false;
    sendButton.disabled = false;
    input.disabled = false;
    input.focus();
    byId('conversation').scrollTop = byId('conversation').scrollHeight;
  }
}

function renderMemories() {
  const list = byId('memory-list');
  byId('memory-count').textContent = String(state.memories.length);
  list.replaceChildren();
  if (!state.memories.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-note';
    empty.textContent = 'No saved details yet. Add one here or save a message.';
    list.append(empty);
    return;
  }
  for (const memory of state.memories) {
    const item = document.createElement('div');
    item.className = 'memory-item';
    const text = document.createElement('span');
    text.textContent = memory.content;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = 'Forget this detail';
    remove.setAttribute('aria-label', `Forget: ${memory.content}`);
    remove.textContent = '×';
    remove.addEventListener('click', async () => {
      try {
        await api(`/api/memories/${memory.id}`, { method: 'DELETE' });
        await loadMemories();
        notify('Memory removed.');
      } catch (error) { notify(error.message); }
    });
    item.append(text, remove);
    list.append(item);
  }
}

async function loadMemories() {
  state.memories = await api('/api/memories');
  renderMemories();
}

async function addMemory(content) {
  const value = content.trim();
  if (!value) return;
  try {
    await api('/api/memories', { method: 'POST', body: JSON.stringify({ content: value }) });
    await loadMemories();
    notify('Saved to long-term memory on this PC.');
  } catch (error) { notify(error.message); }
}

async function refreshAwareness() {
  try {
    const info = await api('/api/awareness');
    byId('local-clock').textContent = info.local_time;
    byId('memory-state').textContent = info.memory_used_percent === null ? 'Unavailable' : `${info.memory_used_percent}% of system RAM`;
    byId('uptime-state').textContent = info.uptime_hours === null ? 'Unavailable' : `${info.uptime_hours} hours`;
    byId('compute-state').textContent = `${info.processor_threads} logical threads`;
  } catch { byId('local-clock').textContent = 'Local PC status unavailable'; }
}

async function scanProcesses() {
  const button = byId('refresh-processes');
  button.disabled = true;
  try {
    const result = await api('/api/processes');
    state.processes = result.processes || [];
    const list = byId('process-list');
    list.replaceChildren();
    if (!state.processes.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'No user-session process names found.';
      list.append(empty);
    }
    for (const name of state.processes) {
      const chip = document.createElement('span');
      chip.className = 'process-chip';
      chip.textContent = name;
      list.append(chip);
    }
    const include = byId('include-processes');
    include.disabled = state.processes.length === 0;
    include.checked = false;
    notify(`${state.processes.length} local process names loaded; sharing is off.`);
  } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
}

async function refreshModels() {
  try {
    const status = await api('/api/status');
    state.models = status.models || [];
    state.ollamaAvailable = status.ollama;
    state.recommendedModel = status.recommended_model || 'qwen3:4b';
    const installedNames = state.models.map((model) => model.name);
    const savedModel = localStorage.getItem('stony-model');
    const initialModel = savedModel || (installedNames.includes(state.recommendedModel)
      ? state.recommendedModel
      : installedNames.includes('qwen2.5-coder:3b')
        ? 'qwen2.5-coder:3b'
        : installedNames[0] || state.recommendedModel);
    const names = [...new Set([state.recommendedModel, ...installedNames, initialModel].filter(Boolean))];
    modelSelect.replaceChildren(...names.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      return option;
    }));
    modelSelect.value = names.includes(initialModel) ? initialModel : state.recommendedModel;
    modelSelect.title = status.ollama ? 'Local Ollama model' : 'Ollama is not responding. Open the Ollama app.';
    updateModelStatus();
  } catch {
    modelSelect.innerHTML = '<option value="qwen3:4b">qwen3:4b</option>';
    updateModelStatus();
  }
}

function updateModelStatus() {
  const status = byId('model-state');
  if (!state.ollamaAvailable) {
    status.textContent = 'Ollama offline · open Ollama app';
    return;
  }
  const installed = state.models.some((model) => model.name === modelSelect.value);
  if (!installed) {
    status.textContent = `Missing · run ollama pull ${modelSelect.value}`;
  } else if (modelSelect.value === state.recommendedModel) {
    status.textContent = 'Ready · recommended for this PC';
  } else {
    status.textContent = `Ready · ${modelSelect.value}; qwen3:4b is recommended`;
  }
}

async function fetchHeadlines() {
  const button = byId('fetch-news');
  button.disabled = true;
  try {
    const result = await api('/api/news');
    state.news = result.items || [];
    state.newsLoadedAt = new Date();
    const list = byId('news-list');
    list.replaceChildren();
    if (!state.news.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'No headlines were available in the feed.';
      list.append(empty);
    }
    for (const item of state.news) {
      const link = document.createElement('a');
      link.className = 'news-item';
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = item.title;
      const source = document.createElement('small');
      source.textContent = `${item.source} · fetched ${state.newsLoadedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      link.append(source);
      list.append(link);
    }
    byId('include-news').disabled = !state.news.length;
    byId('include-news').checked = state.news.length > 0;
    notify('Headlines fetched from NPR.');
  } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
}

function closeMobilePanels() {
  byId('sidebar').classList.remove('open');
  byId('inspector').classList.remove('open');
  byId('mobile-scrim').classList.remove('open');
}

byId('new-chat').addEventListener('click', startBlankChat);
byId('refresh-chats').addEventListener('click', () => loadChats().catch((error) => notify(error.message)));
byId('refresh-awareness').addEventListener('click', refreshAwareness);
byId('refresh-processes').addEventListener('click', scanProcesses);
byId('fetch-news').addEventListener('click', fetchHeadlines);
byId('menu-button').addEventListener('click', () => {
  byId('inspector').classList.remove('open');
  byId('sidebar').classList.toggle('open');
  byId('mobile-scrim').classList.toggle('open', byId('sidebar').classList.contains('open'));
});
byId('inspector-button').addEventListener('click', () => {
  byId('sidebar').classList.remove('open');
  byId('inspector').classList.toggle('open');
  byId('mobile-scrim').classList.toggle('open', byId('inspector').classList.contains('open'));
});
byId('mobile-scrim').addEventListener('click', closeMobilePanels);
const themeToggle = byId('theme-toggle');
function setTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  themeToggle.title = `Switch to ${dark ? 'light' : 'dark'} theme`;
  themeToggle.setAttribute('aria-label', themeToggle.title);
  themeToggle.querySelector('span').textContent = dark ? '☀' : '◐';
  localStorage.setItem('stony-theme', dark ? 'dark' : 'light');
}
setTheme(localStorage.getItem('stony-theme') || 'light');
themeToggle.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
byId('composer-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (input.value.trim()) sendMessage(input.value);
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    byId('composer-form').requestSubmit();
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
});
modelSelect.addEventListener('change', () => {
  localStorage.setItem('stony-model', modelSelect.value);
  updateModelStatus();
});
contextSelect.value = localStorage.getItem('stony-context') || '4096';
contextSelect.addEventListener('change', () => localStorage.setItem('stony-context', contextSelect.value));
const rationaleToggle = byId('rationale-toggle');
rationaleToggle.checked = localStorage.getItem('stony-rationale') !== 'false';
rationaleToggle.addEventListener('change', () => localStorage.setItem('stony-rationale', String(rationaleToggle.checked)));
const autoMemoryToggle = byId('auto-memory-toggle');
autoMemoryToggle.checked = localStorage.getItem('stony-auto-memory') !== 'false';
autoMemoryToggle.addEventListener('change', () => localStorage.setItem('stony-auto-memory', String(autoMemoryToggle.checked)));
byId('memory-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const memoryInput = byId('memory-input');
  await addMemory(memoryInput.value);
  memoryInput.value = '';
});
document.querySelectorAll('.prompt-card').forEach((button) => {
  button.addEventListener('click', () => {
    input.value = button.dataset.prompt || '';
    input.focus();
    input.dispatchEvent(new Event('input'));
  });
});

window.addEventListener('popstate', () => {
  const chatId = chatIdFromPath();
  if (chatId) loadChat(chatId, { updateUrl: false });
  else startBlankChat({ updateUrl: false });
});

Promise.all([loadChats(), loadMemories(), refreshAwareness(), refreshModels()])
  .then(() => {
    const chatId = chatIdFromPath();
    if (chatId) return loadChat(chatId, { updateUrl: false });
    if (window.location.pathname !== '/') setChatPath(null, true);
  })
  .catch((error) => notify(error.message));
