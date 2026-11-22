window.BookSpace = (() => {
  const view = document.getElementById("book-view");
  const backBtn = document.getElementById("book-back-btn");
  const shelfModeBtn = document.getElementById("book-shelf-mode-btn");
  const newModeBtn = document.getElementById("book-new-mode-btn");

  const shelfWrap = document.getElementById("book-shelf-wrap");
  const shelfEmpty = document.getElementById("book-shelf-empty");
  const shelfRows = document.getElementById("book-shelf-rows");

  const createWrap = document.getElementById("book-create-wrap");
  const createForm = document.getElementById("book-create-form");
  const topicInput = document.getElementById("book-topic-input");
  const errorEl = document.getElementById("book-error");

  const loadingWrap = document.getElementById("book-loading");
  const loadingText = document.getElementById("book-loading-text");

  const readerWrap = document.getElementById("book-reader");
  const spreadEl = document.getElementById("book-spread");
  const leftBody = document.getElementById("book-left-body");
  const leftNum = document.getElementById("book-left-num");
  const rightBody = document.getElementById("book-right-body");
  const rightNum = document.getElementById("book-right-num");
  const prevPageBtn = document.getElementById("book-prev-page");
  const nextPageBtn = document.getElementById("book-next-page");
  const pageIndicator = document.getElementById("book-page-indicator");

  const addPageForm = document.getElementById("book-add-page-form");
  const addInstructionInput = document.getElementById("book-add-instruction");

  if (!view) return { open: () => {}, close: () => {}, setHelpers: () => {} };

  const SPINE_COLORS = [
    "linear-gradient(180deg, #1e3a8a 0%, #1d4ed8 100%)",
    "linear-gradient(180deg, #065f46 0%, #059669 100%)",
    "linear-gradient(180deg, #7c2d12 0%, #c2410c 100%)",
    "linear-gradient(180deg, #312e81 0%, #4338ca 100%)",
    "linear-gradient(180deg, #134e4a 0%, #0f766e 100%)",
    "linear-gradient(180deg, #7f1d1d 0%, #b91c1c 100%)",
  ];

  let renderMarkdown = (t) => t;
  let renderMath = () => {};
  let books = [];
  let activeBook = null;
  let displayPages = []; // 実際の紙面高さにぴったり収まるよう自動割付されたページ配列
  let spreadIndex = 0; // 0: [表紙/目次 | P.1], 1: [P.2 | P.3], 2: [P.4 | P.5] ...

  function setHelpers(helpers) {
    if (helpers.renderMarkdown) renderMarkdown = helpers.renderMarkdown;
    if (helpers.renderMath) renderMath = helpers.renderMath;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function showMode(mode) {
    shelfWrap.hidden = mode !== "shelf";
    createWrap.hidden = mode !== "create";
    loadingWrap.hidden = mode !== "loading";
    readerWrap.hidden = mode !== "reader";
  }

  function getTotalSpreads(pageCount) {
    // 0: 表紙+P1, 1: P2+P3, 2: P4+P5 ...
    return 1 + Math.ceil(Math.max(0, pageCount - 1) / 2);
  }

  function renderShelf() {
    shelfRows.innerHTML = "";
    shelfEmpty.hidden = books.length > 0;
    if (books.length === 0) return;

    const perRow = 10;
    for (let start = 0; start < books.length; start += perRow) {
      const slice = books.slice(start, start + perRow);
      const row = document.createElement("div");
      row.className = "shelf-row";

      const booksBar = document.createElement("div");
      booksBar.className = "shelf-row-books";

      slice.forEach((b, idx) => {
        const spine = document.createElement("div");
        spine.className = "spine-book";
        spine.style.background = SPINE_COLORS[(b.id + idx) % SPINE_COLORS.length];
        spine.style.height = `${192 + ((b.id * 17) % 24)}px`;
        spine.style.setProperty("--spine-delay", `${(start + idx) * 65}ms`);
        spine.title = `${b.title}（${b.page_count}ページ / 参考RAG ${b.based_on_count}件）`;

        spine.innerHTML = `
          <span class="spine-title">${escapeHtml(b.title)}</span>
          <span class="spine-pages">${b.page_count}P</span>
          <button type="button" class="spine-delete" aria-label="削除" data-delete-book="${b.id}">×</button>
        `;

        spine.addEventListener("click", async (e) => {
          const del = e.target.closest("[data-delete-book]");
          if (del) {
            e.stopPropagation();
            const id = Number(del.getAttribute("data-delete-book"));
            await fetch(`/api/books/${id}`, { method: "DELETE" });
            if (activeBook && activeBook.id === id) activeBook = null;
            await loadBooks();
            renderShelf();
            return;
          }
          await openBookById(b.id);
        });

        booksBar.appendChild(spine);
      });

      const board = document.createElement("div");
      board.className = "shelf-wood-board";

      row.appendChild(booksBar);
      row.appendChild(board);
      shelfRows.appendChild(row);
    }
  }

  function paginateBookForViewport(rawPages) {
    // 縦スクロールを一切出さず、紙面の高さに収まらないブロックを自動的に次の紙面ページへ送る
    const measureHost = document.createElement("div");
    measureHost.className = "book-page-scroll answer-body";
    const sampleWidth = Math.max(320, (rightBody.clientWidth || 460));
    const maxHeight = Math.max(340, (rightBody.clientHeight || 460) - 8);
    measureHost.style.cssText = `
      position: fixed; left: -9999px; top: 0;
      width: ${sampleWidth}px; visibility: hidden; pointer-events: none;
      overflow: visible;
    `;
    document.body.appendChild(measureHost);

    const out = [];
    for (const p of rawPages) {
      const tmp = document.createElement("div");
      tmp.innerHTML = renderMarkdown(p.content_md || "");
      renderMath(tmp);
      const children = Array.from(tmp.children);
      if (children.length === 0) {
        out.push({ title: p.chapter_title, html: tmp.innerHTML });
        continue;
      }

      let curNodes = [];
      let subIdx = 0;

      for (const child of children) {
        measureHost.innerHTML = "";
        for (const n of curNodes) measureHost.appendChild(n.cloneNode(true));
        measureHost.appendChild(child.cloneNode(true));

        if (curNodes.length > 0 && measureHost.scrollHeight > maxHeight) {
          const wrap = document.createElement("div");
          for (const n of curNodes) wrap.appendChild(n);
          out.push({
            title: subIdx === 0 ? p.chapter_title : `${p.chapter_title}（続き）`,
            html: wrap.innerHTML,
          });
          curNodes = [child];
          subIdx++;
        } else {
          curNodes.push(child);
        }
      }

      if (curNodes.length > 0) {
        const wrap = document.createElement("div");
        for (const n of curNodes) wrap.appendChild(n);
        out.push({
          title: subIdx === 0 ? p.chapter_title : `${p.chapter_title}（続き）`,
          html: wrap.innerHTML,
        });
      }
    }

    document.body.removeChild(measureHost);
    return out.map((item, idx) => ({ ...item, page_number: idx + 1 }));
  }

  function renderSpread(flipDir = "") {
    if (!activeBook || !activeBook.pages || activeBook.pages.length === 0) {
      showMode("shelf");
      return;
    }

    showMode("reader");
    displayPages = paginateBookForViewport(activeBook.pages);
    const pages = displayPages;
    const totalSpreads = getTotalSpreads(pages.length);
    spreadIndex = Math.max(0, Math.min(totalSpreads - 1, spreadIndex));

    if (flipDir && spreadEl) {
      spreadEl.classList.remove("is-flip-next", "is-flip-prev");
      void spreadEl.offsetWidth;
      spreadEl.classList.add(flipDir === "next" ? "is-flip-next" : "is-flip-prev");
    }

    if (spreadIndex === 0) {
      // 左ページ：表紙＆目次（最大8項目まで綺麗に収める）
      const tocButtons = pages
        .slice(0, 8)
        .map(
          (p, i) =>
            `<li><button type="button" data-jump-page="${i}">P.${p.page_number}　${escapeHtml(p.title)}</button></li>`
        )
        .join("");

      leftBody.innerHTML = `
        <div class="book-cover-panel">
          <div>
            <span class="book-cover-badge">学萌 オーダーメイド教科書</span>
            <h2 class="book-cover-title">${escapeHtml(activeBook.title)}</h2>
            <p style="margin:0;font-size:13px;color:var(--ink-muted);">
              過去のRAG記憶 <strong>${activeBook.based_on_count || 0}件</strong> をもとに執筆（全 ${pages.length} ページ）
            </p>
            <ul class="book-cover-toc">${tocButtons}</ul>
          </div>
          <div style="font-size:12px;color:var(--ink-muted);">作成日: ${escapeHtml((activeBook.created_at || "").slice(0, 16))}</div>
        </div>
      `;
      leftNum.textContent = "表紙・目次";

      leftBody.querySelectorAll("[data-jump-page]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const pIdx = Number(btn.getAttribute("data-jump-page"));
          spreadIndex = pIdx === 0 ? 0 : Math.ceil(pIdx / 2);
          renderSpread("next");
        });
      });

      // 右ページ：P.1
      const p1 = pages[0];
      rightBody.innerHTML = p1.html || "";
      rightNum.textContent = `P. ${p1.page_number}`;
      pageIndicator.textContent = `表紙 / P.1（全${pages.length}P）`;
    } else {
      const leftIdx = spreadIndex * 2 - 1;
      const rightIdx = spreadIndex * 2;
      const pLeft = pages[leftIdx];
      const pRight = pages[rightIdx];

      if (pLeft) {
        leftBody.innerHTML = pLeft.html || "";
        leftNum.textContent = `P. ${pLeft.page_number}`;
      } else {
        leftBody.innerHTML = "";
        leftNum.textContent = "";
      }

      if (pRight) {
        rightBody.innerHTML = pRight.html || "";
        rightNum.textContent = `P. ${pRight.page_number}`;
        pageIndicator.textContent = `P.${pLeft.page_number} - P.${pRight.page_number}（全${pages.length}P）`;
      } else {
        rightBody.innerHTML = `
          <div style="height:100%;display:flex;align-items:center;justify-content:center;text-align:center;color:var(--ink-muted);font-size:14px;">
            下の欄から指示を出すと、この次のページ（P.${pages.length + 1}〜）をAIが続けて執筆します。
          </div>
        `;
        rightNum.textContent = `P. ${pages.length + 1}（未執筆）`;
        pageIndicator.textContent = `P.${pLeft.page_number}（全${pages.length}P）`;
      }
    }

    prevPageBtn.disabled = spreadIndex === 0;
    nextPageBtn.disabled = spreadIndex >= totalSpreads - 1;
  }

  async function loadBooks() {
    try {
      const res = await fetch("/api/books");
      const data = await res.json();
      books = data.items || [];
    } catch {
      books = [];
    }
  }

  async function openBookById(bookId) {
    try {
      const res = await fetch(`/api/books/${bookId}`);
      if (!res.ok) return;
      activeBook = await res.json();
      spreadIndex = 0;
      renderSpread("");
    } catch {}
  }

  createForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const topic = topicInput.value.trim();
    if (!topic) {
      errorEl.textContent = "教科書のテーマを入力してください。";
      errorEl.hidden = false;
      return;
    }

    loadingText.textContent = `「${topic}」に関連するRAG記憶（最大20件）を集めて教科書を作成しています…`;
    showMode("loading");

    try {
      const res = await fetch("/api/books/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "教科書の作成に失敗しました。");

      activeBook = data;
      spreadIndex = 0;
      topicInput.value = "";
      await loadBooks();
      renderSpread("next");
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : "作成エラーが発生しました。";
      errorEl.hidden = false;
      showMode("create");
    }
  });

  addPageForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!activeBook) return;
    const instruction = addInstructionInput.value.trim();
    const bookId = activeBook.id;

    loadingText.textContent = "過去のRAG記憶を参照して、新しいページを執筆しています…";
    showMode("loading");

    try {
      const res = await fetch(`/api/books/${bookId}/pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "ページの追加に失敗しました。");

      activeBook = data.book;
      addInstructionInput.value = "";
      await loadBooks();
      showMode("reader");
      displayPages = paginateBookForViewport(activeBook.pages);
      const lastPageIdx = Math.max(0, displayPages.length - 1);
      spreadIndex = lastPageIdx === 0 ? 0 : Math.ceil(lastPageIdx / 2);
      renderSpread("next");
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : "ページ追加エラーが発生しました。";
      errorEl.hidden = false;
      renderSpread("");
    }
  });

  prevPageBtn?.addEventListener("click", () => {
    if (spreadIndex > 0) {
      spreadIndex--;
      renderSpread("prev");
    }
  });

  nextPageBtn?.addEventListener("click", () => {
    if (!activeBook) return;
    const total = getTotalSpreads(displayPages.length || (activeBook.pages || []).length);
    if (spreadIndex < total - 1) {
      spreadIndex++;
      renderSpread("next");
    }
  });

  shelfModeBtn?.addEventListener("click", async () => {
    await loadBooks();
    renderShelf();
    showMode("shelf");
  });

  newModeBtn?.addEventListener("click", () => {
    errorEl.hidden = true;
    showMode("create");
    topicInput.focus();
  });

  async function open() {
    view.hidden = false;
    errorEl.hidden = true;
    await loadBooks();
    if (books.length > 0) {
      renderShelf();
      showMode("shelf");
    } else {
      showMode("create");
      topicInput.focus();
    }
  }

  async function openAndCreate(topic) {
    const cleanTopic = String(topic || "").trim();
    if (!cleanTopic) {
      await open();
      return;
    }
    view.hidden = false;
    errorEl.hidden = true;
    await loadBooks();
    showMode("create");
    topicInput.value = cleanTopic;
    createForm?.requestSubmit();
  }

  function close() {
    view.hidden = true;
  }

  backBtn?.addEventListener("click", close);

  return { open, openAndCreate, close, setHelpers };
})();
