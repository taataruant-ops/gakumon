window.UserSession = (() => {
  const STORAGE_USER_KEY = "study_tutor_user_v1";
  let currentUser = (localStorage.getItem(STORAGE_USER_KEY) || "").trim();

  // 全 /api/ リクエストへ自動的に X-User-Name ヘッダーを付与
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.startsWith("/api/") || url.includes("/api/")) {
      const headers = new Headers(init.headers || (typeof input !== "string" && input?.headers ? input.headers : undefined));
      if (!headers.has("X-User-Name")) {
        headers.set("X-User-Name", encodeURIComponent(currentUser || "default"));
      }
      init = { ...init, headers };
    }
    return origFetch(input, init);
  };

  function getUser() {
    return currentUser || "default";
  }

  function hasUser() {
    return Boolean(currentUser);
  }

  function updatePill() {
    const label = document.getElementById("user-pill-name");
    if (label) {
      label.textContent = currentUser || "ユーザー未設定";
    }
  }

  function setUser(name, emit = true) {
    const clean = String(name || "").trim().slice(0, 40);
    if (!clean) return false;
    currentUser = clean;
    localStorage.setItem(STORAGE_USER_KEY, clean);
    updatePill();
    closeModal();
    if (emit) {
      window.dispatchEvent(new CustomEvent("user-changed", { detail: { user: clean } }));
    }
    return true;
  }

  function openPicker(allowCancel = true) {
    const backdrop = document.getElementById("user-modal-backdrop");
    const modal = document.getElementById("user-modal");
    const closeBtn = document.getElementById("close-user-modal-btn");
    const input = document.getElementById("user-name-input");
    if (!backdrop || !modal) return;
    if (closeBtn) closeBtn.hidden = !allowCancel;
    backdrop.dataset.allowCancel = allowCancel ? "1" : "0";
    backdrop.hidden = false;
    modal.hidden = false;
    if (input) {
      input.value = currentUser === "default" ? "" : currentUser;
      setTimeout(() => input.focus(), 60);
    }
  }

  function closeModal() {
    const backdrop = document.getElementById("user-modal-backdrop");
    const modal = document.getElementById("user-modal");
    if (backdrop) backdrop.hidden = true;
    if (modal) modal.hidden = true;
  }

  function initUI() {
    updatePill();
    const pillBtn = document.getElementById("user-pill-btn");
    const form = document.getElementById("user-name-form");
    const input = document.getElementById("user-name-input");
    const closeBtn = document.getElementById("close-user-modal-btn");
    const backdrop = document.getElementById("user-modal-backdrop");
    const errEl = document.getElementById("user-name-error");

    pillBtn?.addEventListener("click", () => openPicker(true));
    closeBtn?.addEventListener("click", () => closeModal());
    backdrop?.addEventListener("click", () => {
      if (backdrop.dataset.allowCancel === "1") closeModal();
    });

    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      const val = (input?.value || "").trim();
      if (!val) {
        if (errEl) {
          errEl.textContent = "ユーザー名を入力してください。";
          errEl.hidden = false;
        }
        return;
      }
      if (errEl) errEl.hidden = true;
      setUser(val, true);
    });

    if (!currentUser) {
      openPicker(false);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initUI);
  } else {
    initUI();
  }

  return { getUser, setUser, hasUser, openPicker };
})();
