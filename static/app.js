const STORAGE_CHATS_KEY = "study_tutor_chats_v1";
const STORAGE_THRESHOLD_KEY = "study_tutor_threshold_v1";

const state = {
  imageData: "",
  threshold: Number(localStorage.getItem(STORAGE_THRESHOLD_KEY) || "0.62"),
  currentChatId: null,
  chats: [],
  mistakes: [],
  ragMemories: [],
  busy: false,
};

const el = {
  gakumonBrandBtn: document.getElementById("gakumon-brand-btn"),
  historyBtn: document.getElementById("history-btn"),
  openQuizBtn: document.getElementById("open-quiz-btn"),
  openVoiceBtn: document.getElementById("open-voice-btn"),
  openNoteBtn: document.getElementById("open-note-btn"),
  openBookBtn: document.getElementById("open-book-btn"),
  settingsBtn: document.getElementById("settings-btn"),
  openRagViewBtn: document.getElementById("open-rag-view-btn"),
  drawerRagMapBtn: document.getElementById("drawer-rag-map-btn"),
  chatFeed: document.getElementById("chat-feed"),
  composerDock: document.getElementById("composer-dock"),
  askForm: document.getElementById("ask-form"),
  questionInput: document.getElementById("question-input"),
  imageInput: document.getElementById("image-input"),
  attachBtn: document.getElementById("attach-btn"),
  attachMenu: document.getElementById("attach-menu"),
  attachImageOpt: document.getElementById("attach-image-opt"),
  attachNoteOpt: document.getElementById("attach-note-opt"),
  notePickerBackdrop: document.getElementById("note-picker-backdrop"),
  notePickerModal: document.getElementById("note-picker-modal"),
  closeNotePickerBtn: document.getElementById("close-note-picker-btn"),
  notePickerEmpty: document.getElementById("note-picker-empty"),
  notePickerList: document.getElementById("note-picker-list"),
  imagePreviewWrap: document.getElementById("image-preview-wrap"),
  imagePreview: document.getElementById("image-preview"),
  clearImageBtn: document.getElementById("clear-image-btn"),
  askBtn: document.getElementById("ask-btn"),
  errorBanner: document.getElementById("error-banner"),

  drawerBackdrop: document.getElementById("drawer-backdrop"),
  historyDrawer: document.getElementById("history-drawer"),
  closeDrawerBtn: document.getElementById("close-drawer-btn"),
  newChatBtn: document.getElementById("new-chat-btn"),
  tabChats: document.getElementById("tab-chats"),
  tabMistakes: document.getElementById("tab-mistakes"),
  tabRag: document.getElementById("tab-rag"),
  panelChats: document.getElementById("panel-chats"),
  panelMistakes: document.getElementById("panel-mistakes"),
  panelRag: document.getElementById("panel-rag"),
  chatsEmpty: document.getElementById("chats-empty"),
  chatsList: document.getElementById("chats-list"),
  notebookCount: document.getElementById("notebook-count"),
  filterInput: document.getElementById("filter-input"),
  notebookEmpty: document.getElementById("notebook-empty"),
  notebookList: document.getElementById("notebook-list"),
  ragCount: document.getElementById("rag-count"),
  ragEmpty: document.getElementById("rag-empty"),
  ragList: document.getElementById("rag-list"),

  settingsBackdrop: document.getElementById("settings-backdrop"),
  settingsModal: document.getElementById("settings-modal"),
  closeSettingsBtn: document.getElementById("close-settings-btn"),
  statusLlm: document.getElementById("status-llm"),
  statusEmbed: document.getElementById("status-embed"),
  thresholdRange: document.getElementById("threshold-range"),
  thresholdValue: document.getElementById("threshold-value"),
  replayAnimBtn: document.getElementById("replay-anim-btn"),
};

function createGakumonAvatar(mode = "idle") {
  const wrap = document.createElement("div");
  wrap.className = `gakumon-avatar is-${mode}`;
  wrap.title = "学萌";
  wrap.innerHTML = `
    <div class="mascot-think-dots" aria-hidden="true"><span></span><span></span><span></span></div>
    <div class="mascot-waves" aria-hidden="true"><span></span><span></span><span></span></div>
    <img src="/static/gakumon-mascot.jpg" alt="学萌" class="gakumon-mascot-img" />
    <svg class="mascot-book" viewBox="0 0 48 34" fill="none" aria-hidden="true">
      <path d="M4 7 C11 5, 19 6, 24 10 L24 30 C19 26, 11 25, 4 27 Z" fill="#ffffff" stroke="#1d4ed8" stroke-width="2.2" stroke-linejoin="round" />
      <path d="M44 7 C37 5, 29 6, 24 10 L24 30 C29 26, 37 25, 44 27 Z" fill="#fef3c7" stroke="#d97706" stroke-width="2.2" stroke-linejoin="round" />
      <line x1="9" y1="13" x2="19" y2="14" stroke="#93c5fd" stroke-width="2" stroke-linecap="round" />
      <line x1="9" y1="19" x2="19" y2="20" stroke="#93c5fd" stroke-width="2" stroke-linecap="round" />
      <line x1="29" y1="14" x2="39" y2="13" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" />
      <line x1="29" y1="20" x2="39" y2="19" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" />
    </svg>
  `;
  return wrap;
}

window.setMascotState = function setMascotState() {};

function runBootAnimation() {
  document.body.classList.add("is-booting");
  void document.body.offsetWidth;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.remove("is-booting");
    });
  });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatInline(text) {
  // 数式($...$, $$...$$)とインラインコードを先に退避して、* 等が誤変換されないようにする
  const tokens = [];
  const stash = (html) => {
    const idx = tokens.length;
    tokens.push(html);
    return `\u0000T${idx}\u0000`;
  };

  let s = text
    .replace(/`([^`]+)`/g, (_, code) => stash(`<code>${code}</code>`))
    .replace(/\$\$([\s\S]+?)\$\$/g, (m) => stash(m))
    .replace(/\$([^$\n]+?)\$/g, (m) => stash(m));

  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  return s.replace(/\u0000T(\d+)\u0000/g, (_, i) => tokens[Number(i)]);
}

function renderMarkdownLite(raw) {
  const escaped = escapeHtml(raw);
  const blocks = escaped.split(/```([\s\S]*?)```/g);
  const htmlParts = [];

  for (let i = 0; i < blocks.length; i++) {
    if (i % 2 === 1) {
      const codeLines = blocks[i].replace(/^\w+\n/, "");
      htmlParts.push(`<pre><code>${codeLines}</code></pre>`);
      continue;
    }

    const lines = blocks[i].split("\n");
    let listType = null; // "ul" | "ol"
    let inQuote = false;

    const closeList = () => {
      if (listType) {
        htmlParts.push(`</${listType}>`);
        listType = null;
      }
    };
    const closeQuote = () => {
      if (inQuote) {
        htmlParts.push("</blockquote>");
        inQuote = false;
      }
    };

    for (let idx = 0; idx < lines.length; idx++) {
      const trimmed = lines[idx].trim();
      if (!trimmed) {
        closeList();
        closeQuote();
        continue;
      }

      // テーブル判定（| ... | の行と次行の | --- |）
      if (
        trimmed.startsWith("|") &&
        idx + 1 < lines.length &&
        /^\|?[\s:|-]+\|[\s:|-]*$/.test(lines[idx + 1].trim())
      ) {
        closeList();
        closeQuote();
        const parseRow = (rowStr) =>
          rowStr
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((c) => c.trim());

        const headers = parseRow(trimmed);
        idx += 2;
        const bodyRows = [];
        while (idx < lines.length && lines[idx].trim().startsWith("|")) {
          bodyRows.push(parseRow(lines[idx].trim()));
          idx++;
        }
        idx--;

        htmlParts.push("<table><thead><tr>");
        for (const h of headers) htmlParts.push(`<th>${formatInline(h)}</th>`);
        htmlParts.push("</tr></thead><tbody>");
        for (const row of bodyRows) {
          htmlParts.push("<tr>");
          for (let c = 0; c < headers.length; c++) {
            htmlParts.push(`<td>${formatInline(row[c] || "")}</td>`);
          }
          htmlParts.push("</tr>");
        }
        htmlParts.push("</tbody></table>");
        continue;
      }

      if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
        closeList();
        closeQuote();
        htmlParts.push("<hr />");
      } else if (trimmed.startsWith("&gt; ")) {
        closeList();
        if (!inQuote) {
          htmlParts.push("<blockquote>");
          inQuote = true;
        }
        htmlParts.push(`<p>${formatInline(trimmed.slice(5))}</p>`);
      } else if (/^#{3,6}\s+/.test(trimmed)) {
        closeList();
        closeQuote();
        htmlParts.push(`<h4>${formatInline(trimmed.replace(/^#{3,6}\s+/, ""))}</h4>`);
      } else if (trimmed.startsWith("## ") || trimmed.startsWith("# ")) {
        closeList();
        closeQuote();
        const content = trimmed.replace(/^#+\s*/, "");
        htmlParts.push(`<h3>${formatInline(content)}</h3>`);
      } else if (/^[-*・]\s+/.test(trimmed)) {
        closeQuote();
        if (listType !== "ul") {
          closeList();
          htmlParts.push("<ul>");
          listType = "ul";
        }
        htmlParts.push(`<li>${formatInline(trimmed.replace(/^[-*・]\s+/, ""))}</li>`);
      } else if (/^\d+\.\s+/.test(trimmed)) {
        closeQuote();
        if (listType !== "ol") {
          closeList();
          htmlParts.push("<ol>");
          listType = "ol";
        }
        htmlParts.push(`<li>${formatInline(trimmed.replace(/^\d+\.\s+/, ""))}</li>`);
      } else {
        closeList();
        closeQuote();
        htmlParts.push(`<p>${formatInline(trimmed)}</p>`);
      }
    }

    closeList();
    closeQuote();
  }

  return htmlParts.join("");
}

function renderMathInElementSafe(container) {
  if (typeof window.renderMathInElement === "function") {
    try {
      window.renderMathInElement(container, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
          { left: "\\[", right: "\\]", display: true },
        ],
        throwOnError: false,
      });
    } catch {}
  }
}

function getChatsStorageKey() {
  const u = window.UserSession?.getUser?.() || "default";
  return u === "default" ? STORAGE_CHATS_KEY : `${STORAGE_CHATS_KEY}_${u}`;
}

function loadChatsFromStorage() {
  try {
    const raw = localStorage.getItem(getChatsStorageKey());
    state.chats = raw ? JSON.parse(raw) : [];
  } catch {
    state.chats = [];
  }
}

function saveChatsToStorage() {
  const key = getChatsStorageKey();
  try {
    localStorage.setItem(key, JSON.stringify(state.chats.slice(0, 30)));
  } catch {
    // 容量超過時は古い履歴を削って保存
    state.chats = state.chats.slice(0, 10);
    try {
      localStorage.setItem(key, JSON.stringify(state.chats));
    } catch {}
  }
}

function getCurrentChat() {
  return state.chats.find((c) => c.id === state.currentChatId) || null;
}

function startNewChat() {
  state.currentChatId = null;
  el.chatFeed.innerHTML = "";
  clearError();
  clearImage();
  el.questionInput.value = "";
  document.body.classList.add("is-landing");
  closeDrawer();
  el.questionInput.focus();
}

function renderChatFeed(chat) {
  el.chatFeed.innerHTML = "";
  if (!chat || !chat.turns || chat.turns.length === 0) {
    document.body.classList.add("is-landing");
    return;
  }

  document.body.classList.remove("is-landing");
  for (const turn of chat.turns) {
    appendTurnElements(turn);
  }
  el.chatFeed.scrollTop = el.chatFeed.scrollHeight;
}

function appendUserBubble(question, imageData) {
  const userBubble = document.createElement("div");
  userBubble.className = "turn-user";
  if (imageData) {
    const img = document.createElement("img");
    img.src = imageData;
    img.alt = "質問画像";
    img.className = "turn-user-img";
    userBubble.appendChild(img);
  }
  const qSpan = document.createElement("div");
  qSpan.textContent = question || "（画像の問題）";
  userBubble.appendChild(qSpan);
  el.chatFeed.appendChild(userBubble);
}

function appendTurnElements(turn) {
  appendUserBubble(turn.question, turn.imageData);
  appendAssistantElements(turn);
}

function appendAssistantElements(turn, animateSpeak = false) {
  const row = document.createElement("div");
  row.className = "ai-turn-row";
  const avatar = createGakumonAvatar(animateSpeak ? "speaking" : "idle");
  row.appendChild(avatar);

  const assistantWrap = document.createElement("div");
  assistantWrap.className = "ai-turn-content";

  if (animateSpeak) {
    setTimeout(() => {
      avatar.classList.remove("is-speaking");
      avatar.classList.add("is-idle");
    }, 3600);
  }

  const mistakeHits = (turn.similarMistakes || []).filter((m) => m.source === "mistake");
  if (mistakeHits.length > 0) {
    const recall = document.createElement("div");
    recall.className = "recall-banner";

    const itemsHtml = mistakeHits
      .map((m) => {
        const pct = Math.round((m.similarity || 0) * 100);
        return `
          <li class="recall-item">
            <div class="recall-meta">
              <span>単元: ${escapeHtml(m.subject_tag || "未分類")}（${escapeHtml(m.created_at || "")}）</span>
              <span class="recall-score">類似度 ${pct}%</span>
            </div>
            <div>${escapeHtml(m.question_text)}</div>
          </li>
        `;
      })
      .join("");

    recall.innerHTML = `
      <div class="recall-header">
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
        </svg>
        <h3 class="recall-title">以前、似た問題で間違えていました</h3>
      </div>
      <ul class="recall-list">${itemsHtml}</ul>
    `;
    assistantWrap.appendChild(recall);
  }

  const card = document.createElement("div");
  card.className = "answer-card";

  const tagHtml = turn.suggestedTag
    ? `<span class="tag-chip">${escapeHtml(turn.suggestedTag)}</span>`
    : "";

  const ragBadgeHtml = turn.ragSkipped
    ? `<span class="tag-chip" style="background:#f1f5f9;color:#64748b;border-color:#cbd5e1;">RAGスキップ</span>`
    : `<span class="rag-badge">RAG保存済み</span>`;

  const webSourcesHtml =
    turn.webSources && turn.webSources.length > 0
      ? `<div class="web-sources-box">
          <div class="web-sources-title">Web検索で確認した参考元（${turn.agentSteps ? escapeHtml(turn.agentSteps.join(" → ")) : "Web検索"}）</div>
          <div class="web-sources-links">
            ${turn.webSources
              .slice(0, 4)
              .map(
                (s) =>
                  `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" class="web-source-chip">${escapeHtml(s.title || s.url)}</a>`
              )
              .join("")}
          </div>
        </div>`
      : "";

  card.innerHTML = `
    <div class="answer-meta">
      <strong>解説</strong>
      <div style="display:flex;gap:6px;align-items:center;">
        ${ragBadgeHtml}
        ${tagHtml}
      </div>
    </div>
    ${webSourcesHtml}
    <div class="answer-body">${renderMarkdownLite(turn.explanation || "")}</div>
  `;

  const answerBody = card.querySelector(".answer-body");
  if (answerBody) renderMathInElementSafe(answerBody);

  assistantWrap.appendChild(card);
  row.appendChild(assistantWrap);
  el.chatFeed.appendChild(row);
}

function renderChatsDrawer() {
  el.chatsList.innerHTML = "";
  el.chatsEmpty.hidden = state.chats.length > 0;

  for (const chat of state.chats) {
    const li = document.createElement("li");
    li.className = "drawer-item drawer-item-row";
    const title = chat.title || "無題の質問";

    li.innerHTML = `
      <button type="button" class="drawer-item-btn drawer-item-title-btn" data-open-chat="${chat.id}" title="${escapeHtml(title)}">
        <span class="drawer-item-title-single">${escapeHtml(title)}</span>
      </button>
      <button type="button" class="drawer-delete-red" data-delete-chat="${chat.id}">削除</button>
    `;
    el.chatsList.appendChild(li);
  }
}

function renderMistakesDrawer() {
  if (!el.notebookList || !el.filterInput) return;
  const q = el.filterInput.value.trim().toLowerCase();
  const filtered = state.mistakes.filter((m) => {
    if (!q) return true;
    return (
      (m.question_text || "").toLowerCase().includes(q) ||
      (m.mistake_point || "").toLowerCase().includes(q) ||
      (m.subject_tag || "").toLowerCase().includes(q)
    );
  });

  el.notebookCount.textContent = String(state.mistakes.length);
  el.notebookList.innerHTML = "";

  if (filtered.length === 0) {
    el.notebookEmpty.hidden = false;
    el.notebookEmpty.textContent =
      state.mistakes.length === 0
        ? "まだ記録がありません。解説の「記憶ノートに保存する」から追加できます。"
        : "検索条件に一致する記録がありません。";
    return;
  }

  el.notebookEmpty.hidden = true;
  for (const item of filtered) {
    const li = document.createElement("li");
    li.className = "drawer-item";
    const shortQ =
      item.question_text.length > 80
        ? item.question_text.slice(0, 80) + "…"
        : item.question_text;

    li.innerHTML = `
      <div class="drawer-item-title">${escapeHtml(item.subject_tag || "未分類")}</div>
      <div class="drawer-item-sub">${escapeHtml(shortQ)}</div>
      <div class="recall-point">${escapeHtml(item.mistake_point)}</div>
      <button type="button" class="drawer-delete" data-delete-mistake="${item.id}">削除する</button>
    `;
    renderMathInElementSafe(li);
    el.notebookList.appendChild(li);
  }
}

async function loadMistakes() {
  try {
    const res = await fetch("/api/mistakes");
    const data = await res.json();
    state.mistakes = data.items || [];
    renderMistakesDrawer();
  } catch {}
}

function renderRagDrawer() {
  el.ragCount.textContent = String(state.ragMemories.length);
  el.ragList.innerHTML = "";
  el.ragEmpty.hidden = state.ragMemories.length > 0;

  for (const item of state.ragMemories) {
    const li = document.createElement("li");
    li.className = "drawer-item";
    const shortQ =
      item.question_text.length > 80
        ? item.question_text.slice(0, 80) + "…"
        : item.question_text;

    li.innerHTML = `
      <div class="drawer-item-title">${escapeHtml(item.subject_tag || "未分類")}（${escapeHtml((item.created_at || "").slice(0, 16))}）</div>
      <div class="drawer-item-sub">${escapeHtml(shortQ)}</div>
      <div class="recall-point">${escapeHtml(item.key_point || "")}</div>
      <button type="button" class="drawer-delete" data-delete-rag="${item.id}">削除する</button>
    `;
    renderMathInElementSafe(li);
    el.ragList.appendChild(li);
  }
}

async function loadRagMemories() {
  try {
    const res = await fetch("/api/rag");
    const data = await res.json();
    state.ragMemories = data.items || [];
    renderRagDrawer();
  } catch {}
}

async function refreshHealth() {
  const applyPill = (node, ok) => {
    node.textContent = ok ? "稼働中" : "未起動";
    node.classList.remove("is-checking", "is-ok", "is-down");
    node.classList.add(ok ? "is-ok" : "is-down");
  };

  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    applyPill(el.statusLlm, data.llm_ok);
    applyPill(el.statusEmbed, data.embed_ok);
  } catch {
    applyPill(el.statusLlm, false);
    applyPill(el.statusEmbed, false);
  }
}

function setImageFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    state.imageData = String(reader.result || "");
    el.imagePreview.src = state.imageData;
    el.imagePreviewWrap.hidden = false;
  };
  reader.readAsDataURL(file);
}

function clearImage() {
  state.imageData = "";
  el.imageInput.value = "";
  el.imagePreview.src = "";
  el.imagePreviewWrap.hidden = true;
}

function showError(msg) {
  el.errorBanner.textContent = msg;
  el.errorBanner.hidden = false;
}

function clearError() {
  el.errorBanner.hidden = true;
  el.errorBanner.textContent = "";
}

function openDrawer() {
  el.drawerBackdrop.classList.add("is-open");
  el.historyDrawer.classList.add("is-open");
  el.drawerBackdrop.setAttribute("aria-hidden", "false");
  el.historyDrawer.setAttribute("aria-hidden", "false");
  renderChatsDrawer();
  loadMistakes();
  loadRagMemories();
}

function closeDrawer() {
  el.drawerBackdrop.classList.remove("is-open");
  el.historyDrawer.classList.remove("is-open");
  el.drawerBackdrop.setAttribute("aria-hidden", "true");
  el.historyDrawer.setAttribute("aria-hidden", "true");
}

function openSettings() {
  el.settingsBackdrop.hidden = false;
  el.settingsModal.hidden = false;
  refreshHealth();
}

function closeSettings() {
  el.settingsBackdrop.hidden = true;
  el.settingsModal.hidden = true;
}

el.gakumonBrandBtn?.addEventListener("click", startNewChat);
el.historyBtn.addEventListener("click", openDrawer);
el.closeDrawerBtn.addEventListener("click", closeDrawer);
el.drawerBackdrop.addEventListener("click", closeDrawer);
el.newChatBtn.addEventListener("click", startNewChat);

el.settingsBtn.addEventListener("click", openSettings);
el.closeSettingsBtn.addEventListener("click", closeSettings);
el.settingsBackdrop.addEventListener("click", closeSettings);

if (window.RagSpace) {
  window.RagSpace.setMarkdownRenderer(renderMarkdownLite);
  el.openRagViewBtn?.addEventListener("click", () => {
    closeDrawer();
    window.RagSpace.open();
  });
  el.drawerRagMapBtn?.addEventListener("click", () => {
    closeDrawer();
    window.RagSpace.open();
  });
}

if (window.QuizSpace) {
  window.QuizSpace.setHelpers({
    renderMarkdown: renderMarkdownLite,
    renderMath: renderMathInElementSafe,
    onMistakeSaved: loadMistakes,
  });
  el.openQuizBtn?.addEventListener("click", () => {
    closeDrawer();
    window.QuizSpace.open();
  });
}

if (window.VoiceSpace) {
  window.VoiceSpace.setOnRagUpdated(loadRagMemories);
  el.openVoiceBtn?.addEventListener("click", () => {
    closeDrawer();
    window.VoiceSpace.open();
  });
}

if (window.NoteSpace) {
  window.NoteSpace.setCallbacks({
    onAskWithImage: (imgUrl, title, page) => {
      state.imageData = imgUrl;
      el.imagePreview.src = imgUrl;
      el.imagePreviewWrap.hidden = false;
      if (!el.questionInput.value.trim()) {
        el.questionInput.value = `ノート「${title}」(P.${page})の内容を確認して、大事なポイントや間違いがあれば教えてください。`;
      }
      el.questionInput.focus();
    },
    onRagUpdated: loadRagMemories,
  });
  el.openNoteBtn?.addEventListener("click", () => {
    closeDrawer();
    window.NoteSpace.open();
  });
}

if (window.BookSpace) {
  window.BookSpace.setHelpers({
    renderMarkdown: renderMarkdownLite,
    renderMath: renderMathInElementSafe,
  });
  el.openBookBtn?.addEventListener("click", () => {
    closeDrawer();
    window.BookSpace.open();
  });
}

el.tabChats.addEventListener("click", () => {
  el.tabChats.classList.add("is-active");
  el.tabRag.classList.remove("is-active");
  el.panelChats.hidden = false;
  el.panelRag.hidden = true;
});

el.tabRag.addEventListener("click", () => {
  el.tabRag.classList.add("is-active");
  el.tabChats.classList.remove("is-active");
  el.panelRag.hidden = false;
  el.panelChats.hidden = true;
  loadRagMemories();
});

el.chatsList.addEventListener("click", (e) => {
  const openBtn = e.target.closest("[data-open-chat]");
  if (openBtn) {
    const id = openBtn.getAttribute("data-open-chat");
    const chat = state.chats.find((c) => c.id === id);
    if (chat) {
      state.currentChatId = chat.id;
      renderChatFeed(chat);
      closeDrawer();
    }
    return;
  }

  const delBtn = e.target.closest("[data-delete-chat]");
  if (delBtn) {
    const id = delBtn.getAttribute("data-delete-chat");
    state.chats = state.chats.filter((c) => c.id !== id);
    saveChatsToStorage();
    renderChatsDrawer();
    if (state.currentChatId === id) {
      startNewChat();
    }
  }
});

el.notebookList?.addEventListener("click", async (e) => {
  const delBtn = e.target.closest("[data-delete-mistake]");
  if (!delBtn) return;
  const id = delBtn.getAttribute("data-delete-mistake");
  delBtn.disabled = true;
  try {
    const res = await fetch(`/api/mistakes/${id}`, { method: "DELETE" });
    if (res.ok) await loadMistakes();
  } finally {
    delBtn.disabled = false;
  }
});

el.ragList.addEventListener("click", async (e) => {
  const delBtn = e.target.closest("[data-delete-rag]");
  if (!delBtn) return;
  const id = delBtn.getAttribute("data-delete-rag");
  delBtn.disabled = true;
  try {
    const res = await fetch(`/api/rag/${id}`, { method: "DELETE" });
    if (res.ok) await loadRagMemories();
  } finally {
    delBtn.disabled = false;
  }
});

el.filterInput?.addEventListener("input", renderMistakesDrawer);

el.thresholdRange.value = String(state.threshold);
el.thresholdValue.textContent = state.threshold.toFixed(2);
el.thresholdRange.addEventListener("input", () => {
  state.threshold = Number(el.thresholdRange.value);
  el.thresholdValue.textContent = state.threshold.toFixed(2);
  localStorage.setItem(STORAGE_THRESHOLD_KEY, String(state.threshold));
});

el.replayAnimBtn.addEventListener("click", () => {
  closeSettings();
  startNewChat();
  setTimeout(runBootAnimation, 40);
});

function closeAttachMenu() {
  if (el.attachMenu) el.attachMenu.hidden = true;
  el.attachBtn?.setAttribute("aria-expanded", "false");
}

function openNotePicker() {
  if (!window.NoteSpace?.listPages) return;
  const pages = window.NoteSpace.listPages();
  const filled = pages.filter((p) => p.hasContent);
  const targets = filled.length > 0 ? filled : pages;

  el.notePickerList.innerHTML = "";
  el.notePickerEmpty.hidden = filled.length > 0;

  for (const p of targets) {
    const li = document.createElement("li");
    li.className = "drawer-item drawer-item-row";
    li.innerHTML = `
      <button type="button" class="drawer-item-btn drawer-item-title-btn">
        <span class="drawer-item-title-single">${escapeHtml(p.title)} — P.${p.pageIndex + 1}${p.hasContent ? "" : "（白紙）"}</span>
      </button>
    `;
    li.querySelector("button").addEventListener("click", async () => {
      const imgUrl = await window.NoteSpace.exportSpecificPage(p.bookId, p.pageIndex);
      state.imageData = imgUrl;
      el.imagePreview.src = imgUrl;
      el.imagePreviewWrap.hidden = false;
      closeNotePicker();
      el.questionInput.focus();
    });
    el.notePickerList.appendChild(li);
  }

  el.notePickerBackdrop.hidden = false;
  el.notePickerModal.hidden = false;
}

function closeNotePicker() {
  el.notePickerBackdrop.hidden = true;
  el.notePickerModal.hidden = true;
}

el.attachBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = el.attachMenu.hidden;
  el.attachMenu.hidden = !willOpen;
  el.attachBtn.setAttribute("aria-expanded", String(willOpen));
});

el.attachImageOpt?.addEventListener("click", () => {
  closeAttachMenu();
  el.imageInput.click();
});

el.attachNoteOpt?.addEventListener("click", () => {
  closeAttachMenu();
  openNotePicker();
});

el.closeNotePickerBtn?.addEventListener("click", closeNotePicker);
el.notePickerBackdrop?.addEventListener("click", closeNotePicker);

document.addEventListener("click", (e) => {
  if (!el.attachMenu.hidden && !e.target.closest(".attach-wrap")) {
    closeAttachMenu();
  }
});
el.imageInput.addEventListener("change", () => {
  if (el.imageInput.files?.[0]) setImageFile(el.imageInput.files[0]);
});
el.clearImageBtn.addEventListener("click", clearImage);

el.askForm.addEventListener("dragover", (e) => {
  e.preventDefault();
  el.askForm.classList.add("is-dragover");
});
el.askForm.addEventListener("dragleave", () => {
  el.askForm.classList.remove("is-dragover");
});
el.askForm.addEventListener("drop", (e) => {
  e.preventDefault();
  el.askForm.classList.remove("is-dragover");
  if (e.dataTransfer?.files?.[0]) setImageFile(e.dataTransfer.files[0]);
});

document.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) setImageFile(file);
      break;
    }
  }
});

el.questionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    el.askForm.requestSubmit();
  }
});

el.askForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.busy) return;
  clearError();

  const question = el.questionInput.value.trim();
  const imageData = state.imageData;
  if (!question && !imageData) {
    showError("問題文を入力するか、画像を添付してください。");
    return;
  }

  state.busy = true;
  el.askBtn.disabled = true;
  window.setMascotState?.("thinking");

  // ど真ん中から真ん中下へ勾配降下アニメーションで移動
  document.body.classList.remove("is-landing");

  // 自分の送ったメッセージを即座に表示
  appendUserBubble(question, imageData);

  const loadingRow = document.createElement("div");
  loadingRow.className = "ai-turn-row";
  loadingRow.appendChild(createGakumonAvatar("thinking"));

  const loadingCard = document.createElement("div");
  loadingCard.className = "loading-card";
  loadingCard.innerHTML = `
    <div class="bookshelf-loader" aria-hidden="true">
      <div class="shelf-books">
        <span class="shelf-book book-1"></span>
        <span class="shelf-book book-2"></span>
        <span class="shelf-book book-3"></span>
        <span class="shelf-book book-4"></span>
      </div>
      <div class="shelf-plank"></div>
    </div>
    <span class="loading-text">過去の記憶を本棚から探し、解説を作成しています…</span>
  `;
  const loadingContent = document.createElement("div");
  loadingContent.className = "ai-turn-content";
  loadingContent.appendChild(loadingCard);
  loadingRow.appendChild(loadingContent);
  el.chatFeed.appendChild(loadingRow);
  el.chatFeed.scrollTop = el.chatFeed.scrollHeight;

  el.questionInput.value = "";
  clearImage();

  try {
    const activeChat = getCurrentChat();
    const history = [];
    if (activeChat && activeChat.turns) {
      for (const t of activeChat.turns.slice(-3)) {
        if (t.question) history.push({ role: "user", content: t.question });
        if (t.explanation) history.push({ role: "assistant", content: t.explanation });
      }
    }

    const res = await fetch("/api/ask_stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        image_data: imageData,
        threshold: state.threshold,
        history,
      }),
    });
    if (!res.ok || !res.body) {
      let errMsg = "解説の取得に失敗しました。";
      try {
        const errData = await res.json();
        if (errData?.detail) errMsg = errData.detail;
      } catch {}
      throw new Error(errMsg);
    }

    const loadingTextEl = loadingRow.querySelector(".loading-text");
    let streamRow = null;
    let streamBodyEl = null;
    let streamText = "";
    let streamRenderTimer = null;
    let data = null;

    const flushStreamRender = () => {
      streamRenderTimer = null;
      if (!streamBodyEl) return;
      streamBodyEl.innerHTML = renderMarkdownLite(streamText);
      renderMathInElementSafe(streamBodyEl);
      el.chatFeed.scrollTop = el.chatFeed.scrollHeight;
    };

    const scheduleStreamRender = () => {
      if (streamRenderTimer !== null) return;
      streamRenderTimer = setTimeout(flushStreamRender, 80);
    };

    const ensureStreamCard = () => {
      if (streamRow) return;
      loadingRow.hidden = true;
      streamRow = document.createElement("div");
      streamRow.className = "ai-turn-row";
      streamRow.appendChild(createGakumonAvatar("speaking"));

      const wrap = document.createElement("div");
      wrap.className = "ai-turn-content";
      const card = document.createElement("div");
      card.className = "answer-card";
      card.innerHTML = `
        <div class="answer-head">
          <span class="answer-title">解説</span>
          <span class="rag-badge">生成中…</span>
        </div>
        <div class="answer-body js-stream-body"></div>
      `;
      streamBodyEl = card.querySelector(".js-stream-body");
      wrap.appendChild(card);
      streamRow.appendChild(wrap);
      el.chatFeed.appendChild(streamRow);
      window.setMascotState?.("speaking");
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let sseBuf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
      const parts = sseBuf.split("\n\n");
      sseBuf = parts.pop() || "";

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        let ev;
        try {
          ev = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }

        if (ev.type === "status") {
          if (loadingTextEl && ev.text) loadingTextEl.textContent = ev.text;
        } else if (ev.type === "reset") {
          streamText = "";
          if (streamRenderTimer !== null) {
            clearTimeout(streamRenderTimer);
            streamRenderTimer = null;
          }
          if (streamRow) {
            streamRow.remove();
            streamRow = null;
            streamBodyEl = null;
          }
          loadingRow.hidden = false;
        } else if (ev.type === "token" && ev.text) {
          ensureStreamCard();
          streamText += ev.text;
          scheduleStreamRender();
        } else if (ev.type === "done") {
          if (streamRenderTimer !== null) {
            clearTimeout(streamRenderTimer);
            streamRenderTimer = null;
          }
          data = ev;
        } else if (ev.type === "error") {
          throw new Error(ev.message || "解説の取得に失敗しました。");
        }
      }
    }

    loadingRow.remove();
    if (streamRow) streamRow.remove();

    if (!data) {
      throw new Error("応答ストリームが途中で終了しました。");
    }

    let chat = getCurrentChat();
    if (!chat) {
      chat = {
        id: String(Date.now()),
        title: (question || data.effective_question || "画像の質問").slice(0, 32),
        updatedAt: new Date().toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
        turns: [],
      };
      state.chats.unshift(chat);
      state.currentChatId = chat.id;
    } else {
      chat.updatedAt = new Date().toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    }

    const turn = {
      question: question || data.effective_question,
      effectiveQuestion: data.effective_question || question,
      imageData,
      similarMistakes: data.similar_mistakes || [],
      explanation: data.explanation || "",
      suggestedTag: data.suggested_tag || "",
      suggestedPoint: data.suggested_point || "",
      ragSkipped: Boolean(data.rag_skipped),
      agentSteps: data.agent_steps || [],
      webSources: data.web_sources || [],
      saved: false,
    };

    chat.turns.push(turn);
    saveChatsToStorage();
    appendAssistantElements(turn, true);
    loadRagMemories();
    el.chatFeed.scrollTop = el.chatFeed.scrollHeight;
    window.setMascotState?.("speaking", 4200);

    // Gemma 4 E2B が [[START_QUIZ: ...]] タグを出力したら自動でS-CBTテスト画面へ遷移
    if (data.quiz_trigger && window.QuizSpace) {
      setTimeout(() => {
        window.QuizSpace.openAndGenerate(
          data.quiz_trigger.topic,
          data.quiz_trigger.count || 3
        );
      }, 450);
    }
  } catch (err) {
    loadingRow.remove();
    document.querySelectorAll(".js-stream-body").forEach((n) => n.closest(".ai-turn-row")?.remove());
    window.setMascotState?.("idle");
    showError(err instanceof Error ? err.message : "エラーが発生しました。");
  } finally {
    state.busy = false;
    el.askBtn.disabled = false;
  }
});

window.addEventListener("user-changed", () => {
  loadChatsFromStorage();
  startNewChat();
  renderChatsDrawer();
  loadMistakes();
  loadRagMemories();
  refreshHealth();
});

// スマホ（iOS Safari / Android Chrome）のソフトキーボード表示に合わせて入力欄をキーボード直上へ追従させる
function setupMobileKeyboardTracking() {
  const root = document.documentElement;
  let baselineHeight = window.innerHeight;

  const updateViewportVars = () => {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    root.style.setProperty("--vv-height", `${Math.round(h)}px`);
    root.style.setProperty("--vv-offset-top", `${Math.round(top)}px`);

    if (window.innerWidth <= 600) {
      if (h > baselineHeight) baselineHeight = h;
      const activeTag = document.activeElement?.tagName;
      const isTextFocused = activeTag === "TEXTAREA" || activeTag === "INPUT";
      const keyboardOpen = isTextFocused && (h < baselineHeight - 110 || document.activeElement === el.questionInput);
      document.body.classList.toggle("is-keyboard-open", keyboardOpen);
      if (keyboardOpen && !document.body.classList.contains("is-landing")) {
        el.chatFeed.scrollTop = el.chatFeed.scrollHeight;
      }
    } else {
      document.body.classList.remove("is-keyboard-open");
    }
  };

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateViewportVars);
    window.visualViewport.addEventListener("scroll", updateViewportVars);
  }
  window.addEventListener("resize", () => {
    if (window.innerWidth > 600) baselineHeight = window.innerHeight;
    updateViewportVars();
  });

  el.questionInput?.addEventListener("focus", () => {
    setTimeout(updateViewportVars, 60);
    setTimeout(updateViewportVars, 280);
  });
  el.questionInput?.addEventListener("blur", () => {
    setTimeout(updateViewportVars, 120);
  });

  // モーダルやAI本・音声モード内の入力欄もフォーカス時に見切れないようスクロール
  document.addEventListener("focusin", (e) => {
    if (window.innerWidth > 600) return;
    const target = e.target;
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA") &&
      target !== el.questionInput
    ) {
      setTimeout(() => {
        try {
          target.scrollIntoView({ block: "center", behavior: "smooth" });
        } catch {}
      }, 250);
    }
  });

  updateViewportVars();
}

setupMobileKeyboardTracking();

loadChatsFromStorage();
loadMistakes();
loadRagMemories();
refreshHealth();
runBootAnimation();
