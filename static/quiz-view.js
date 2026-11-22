window.QuizSpace = (() => {
  const view = document.getElementById("quiz-view");
  const backBtn = document.getElementById("quiz-back-btn");
  const headerTitle = document.getElementById("quiz-header-title");
  const headerSub = document.getElementById("quiz-header-sub");
  const timerEl = document.getElementById("quiz-timer");
  const progressEl = document.getElementById("quiz-progress");

  const setupWrap = document.getElementById("quiz-setup");
  const setupForm = document.getElementById("quiz-setup-form");
  const topicInput = document.getElementById("quiz-topic-input");
  const countSelect = document.getElementById("quiz-count-select");
  const setupError = document.getElementById("quiz-setup-error");

  const loadingWrap = document.getElementById("quiz-loading");
  const loadingText = document.getElementById("quiz-loading-text");

  const examWrap = document.getElementById("quiz-exam");
  const navGrid = document.getElementById("quiz-nav-grid");
  const finishBtn = document.getElementById("quiz-finish-btn");
  const qNumberEl = document.getElementById("quiz-q-number");
  const qHintEl = document.getElementById("quiz-q-hint");
  const flagBtn = document.getElementById("quiz-flag-btn");
  const qBodyEl = document.getElementById("quiz-q-body");
  const choicesEl = document.getElementById("quiz-choices");
  const prevBtn = document.getElementById("quiz-prev-btn");
  const nextBtn = document.getElementById("quiz-next-btn");

  const resultWrap = document.getElementById("quiz-result");
  const scoreValueEl = document.getElementById("quiz-score-value");
  const scoreTimeEl = document.getElementById("quiz-score-time");
  const retryBtn = document.getElementById("quiz-retry-btn");
  const newTopicBtn = document.getElementById("quiz-new-topic-btn");
  const reviewListEl = document.getElementById("quiz-review-list");

  if (!view) return { open: () => {}, openAndGenerate: () => {}, setHelpers: () => {} };

  const CHOICE_LABELS = ["A", "B", "C", "D"];
  let renderMarkdown = (t) => t;
  let renderMath = () => {};
  let onMistakeSaved = () => {};

  let currentTopic = "";
  let currentCount = 3;
  let questions = [];
  let answers = [];
  let flags = [];
  let currentIndex = 0;
  let startedAt = 0;
  let timerHandle = 0;

  function setHelpers(helpers) {
    if (helpers.renderMarkdown) renderMarkdown = helpers.renderMarkdown;
    if (helpers.renderMath) renderMath = helpers.renderMath;
    if (helpers.onMistakeSaved) onMistakeSaved = helpers.onMistakeSaved;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function stopTimer() {
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = 0;
    }
  }

  function startTimer() {
    stopTimer();
    startedAt = Date.now();
    timerEl.textContent = "00:00";
    timerEl.hidden = false;
    timerHandle = setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      timerEl.textContent = formatDuration(sec);
    }, 1000);
  }

  function showPhase(phase) {
    setupWrap.hidden = phase !== "setup";
    loadingWrap.hidden = phase !== "loading";
    examWrap.hidden = phase !== "exam";
    resultWrap.hidden = phase !== "result";

    if (phase !== "exam") {
      progressEl.hidden = true;
    }
    if (phase === "setup" || phase === "loading") {
      stopTimer();
      timerEl.hidden = true;
    }
  }

  function renderNav() {
    navGrid.innerHTML = "";
    questions.forEach((_, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cbt-nav-btn";
      if (idx === currentIndex) btn.classList.add("is-current");
      if (answers[idx] !== null) btn.classList.add("is-answered");
      if (flags[idx]) btn.classList.add("is-flagged");
      btn.textContent = String(idx + 1);
      btn.addEventListener("click", () => {
        currentIndex = idx;
        renderQuestion();
      });
      navGrid.appendChild(btn);
    });
  }

  function renderQuestion() {
    const q = questions[currentIndex];
    if (!q) return;

    progressEl.textContent = `${currentIndex + 1} / ${questions.length}`;
    progressEl.hidden = false;
    qNumberEl.textContent = `第 ${currentIndex + 1} 問`;

    if (q.source_hint) {
      qHintEl.textContent = q.source_hint;
      qHintEl.hidden = false;
    } else {
      qHintEl.hidden = true;
    }

    flagBtn.classList.toggle("is-active", Boolean(flags[currentIndex]));
    flagBtn.textContent = flags[currentIndex] ? "見直し中" : "見直しフラグ";

    qBodyEl.innerHTML = renderMarkdown(q.question);
    renderMath(qBodyEl);

    choicesEl.innerHTML = "";
    q.choices.forEach((choiceText, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cbt-choice";
      if (answers[currentIndex] === idx) btn.classList.add("is-selected");
      btn.innerHTML = `
        <span class="cbt-choice-key">${CHOICE_LABELS[idx] || idx + 1}</span>
        <span class="cbt-choice-text">${renderMarkdown(choiceText)}</span>
      `;
      renderMath(btn);
      btn.addEventListener("click", () => {
        answers[currentIndex] = idx;
        renderQuestion();
      });
      choicesEl.appendChild(btn);
    });

    prevBtn.disabled = currentIndex === 0;
    nextBtn.textContent = currentIndex === questions.length - 1 ? "採点へ進む" : "次の問題";
    renderNav();
  }

  function showResults() {
    stopTimer();
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    let correctCount = 0;

    reviewListEl.innerHTML = "";
    questions.forEach((q, idx) => {
      const userAns = answers[idx];
      const isCorrect = userAns === q.answer_index;
      if (isCorrect) correctCount++;

      const card = document.createElement("article");
      card.className = `cbt-review-item ${isCorrect ? "is-correct" : "is-wrong"}`;

      const userLabel =
        userAns === null
          ? "未解答"
          : `${CHOICE_LABELS[userAns] || userAns + 1}. ${q.choices[userAns] || ""}`;
      const correctLabel = `${CHOICE_LABELS[q.answer_index] || q.answer_index + 1}. ${q.choices[q.answer_index] || ""}`;

      card.innerHTML = `
        <div class="cbt-review-head">
          <strong>第 ${idx + 1} 問${q.source_hint ? `（${escapeHtml(q.source_hint)}）` : ""}</strong>
          <span class="cbt-judge ${isCorrect ? "is-correct" : "is-wrong"}">${isCorrect ? "正解" : "不正解"}</span>
        </div>
        <div class="answer-body js-rev-q">${renderMarkdown(q.question)}</div>
        <div class="cbt-review-answers">
          <div>あなたの解答: <strong>${escapeHtml(userLabel)}</strong></div>
          <div>正解: <strong>${escapeHtml(correctLabel)}</strong></div>
        </div>
        <div class="answer-body js-rev-exp">${renderMarkdown(q.explanation || "")}</div>
      `;

      renderMath(card);

      reviewListEl.appendChild(card);
    });

    scoreValueEl.textContent = `${correctCount} / ${questions.length} 問正解`;
    scoreTimeEl.textContent = `所要時間 ${formatDuration(elapsedSec)}`;
    showPhase("result");
  }

  async function generateAndStart(topic, count) {
    currentTopic = topic.trim();
    currentCount = Number(count) || 3;
    setupError.hidden = true;

    if (!currentTopic) {
      setupError.textContent = "テストのテーマを入力してください。";
      setupError.hidden = false;
      showPhase("setup");
      return;
    }

    headerTitle.textContent = `苦手克服テスト：${currentTopic}`;
    headerSub.textContent = "過去のつまずき・RAG記憶をもとに問題を作成中…";
    loadingText.textContent = `「${currentTopic}」の苦手克服テスト（${currentCount}問）を作成しています…`;
    showPhase("loading");

    try {
      const res = await fetch("/api/quiz/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: currentTopic, count: currentCount }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "テスト作成に失敗しました。");

      questions = data.questions || [];
      answers = new Array(questions.length).fill(null);
      flags = new Array(questions.length).fill(false);
      currentIndex = 0;

      const basedText =
        data.based_on_count > 0
          ? `過去の記憶 ${data.based_on_count} 件をもとに生成`
          : "指定テーマの典型問題から生成";
      headerSub.textContent = basedText;

      showPhase("exam");
      startTimer();
      renderQuestion();
    } catch (err) {
      setupError.textContent = err instanceof Error ? err.message : "テスト作成エラーが発生しました。";
      setupError.hidden = false;
      topicInput.value = currentTopic;
      showPhase("setup");
    }
  }

  function open() {
    view.hidden = false;
    setupError.hidden = true;
    headerTitle.textContent = "苦手克服 Webテスト（S-CBT）";
    headerSub.textContent = "過去のつまずき・RAG記憶から専用テストを生成します";
    showPhase("setup");
    topicInput.focus();
  }

  function openAndGenerate(topic, count = 3) {
    view.hidden = false;
    topicInput.value = topic || "";
    countSelect.value = String(count === 5 ? 5 : 3);
    generateAndStart(topic, count);
  }

  function close() {
    stopTimer();
    view.hidden = true;
  }

  backBtn?.addEventListener("click", close);

  setupForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    generateAndStart(topicInput.value, Number(countSelect.value));
  });

  flagBtn?.addEventListener("click", () => {
    flags[currentIndex] = !flags[currentIndex];
    renderQuestion();
  });

  prevBtn?.addEventListener("click", () => {
    if (currentIndex > 0) {
      currentIndex--;
      renderQuestion();
    }
  });

  nextBtn?.addEventListener("click", () => {
    if (currentIndex < questions.length - 1) {
      currentIndex++;
      renderQuestion();
    } else {
      showResults();
    }
  });

  finishBtn?.addEventListener("click", showResults);

  retryBtn?.addEventListener("click", () => {
    generateAndStart(currentTopic, currentCount);
  });

  newTopicBtn?.addEventListener("click", () => {
    topicInput.value = currentTopic;
    showPhase("setup");
    topicInput.focus();
  });

  return { open, openAndGenerate, close, setHelpers };
})();
