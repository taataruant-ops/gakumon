window.VoiceSpace = (() => {
  const view = document.getElementById("voice-view");
  const backBtn = document.getElementById("voice-back-btn");
  const orb = document.getElementById("voice-orb");
  const stateLabel = document.getElementById("voice-state-label");
  const userTextEl = document.getElementById("voice-user-text");
  const aiTextEl = document.getElementById("voice-ai-text");
  const micBtn = document.getElementById("voice-mic-btn");
  const interruptBtn = document.getElementById("voice-interrupt-btn");
  const micSelect = document.getElementById("voice-mic-select");
  const micRefreshBtn = document.getElementById("voice-mic-refresh");
  const micMeterFill = document.getElementById("voice-mic-meter-fill");
  const textForm = document.getElementById("voice-text-form");
  const textInput = document.getElementById("voice-text-input");
  const errorEl = document.getElementById("voice-error");

  if (!view) return { open: () => {}, close: () => {}, setOnRagUpdated: () => {} };

  const STORAGE_MIC_KEY = "study_tutor_mic_id_v1";

  let micActive = false;
  let selectedMicId = localStorage.getItem(STORAGE_MIC_KEY) || "";
  let mediaStream = null;
  let audioCtx = null;
  let processorNode = null;
  let history = [];
  let generationId = 0;
  let activeAbort = null;
  let pendingNavAction = null;
  let onRagUpdated = () => {};

  // VAD（自動無音検出）＆ 16kHz WAV 録音用バッファ
  let preRollChunks = [];
  let speechChunks = [];
  let isRecordingSpeech = false;
  let lastVoiceAt = 0;
  let speechStartAt = 0;
  let bargeInFrames = 0;

  function setOnRagUpdated(fn) {
    onRagUpdated = fn;
  }

  function setOrbState(mode, label) {
    orb.classList.remove("is-idle", "is-listening", "is-thinking", "is-speaking");
    orb.classList.add(`is-${mode}`);
    stateLabel.textContent = label;
    interruptBtn.disabled = mode !== "speaking" && mode !== "thinking";
    if (window.setMascotState) {
      window.setMascotState(mode === "thinking" ? "thinking" : mode === "speaking" ? "speaking" : "idle");
    }
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }

  function interruptSpeaking() {
    generationId++;
    pendingNavAction = null;
    if (activeAbort) {
      try { activeAbort.abort(); } catch {}
      activeAbort = null;
    }
    isRecordingSpeech = false;
    speechChunks = [];
    if (micActive) {
      setOrbState("listening", "聞き取り中… そのまま話しかけてください（Gemma 4 直接音声認識）");
    } else {
      setOrbState("idle", "待機中");
    }
  }

  async function consumeSseReply(url, bodyObj, userDisplayLabel) {
    clearError();
    interruptSpeaking();
    const myGen = generationId;
    activeAbort = new AbortController();

    userTextEl.textContent = userDisplayLabel;
    aiTextEl.textContent = "";
    setOrbState("thinking", "Gemma 4 12B が直接音声を聞き取って考えています…");

    let fullReply = "";
    let savedToHistory = false;
    const commitHistory = (heard) => {
      if (savedToHistory || !fullReply.trim()) return;
      savedToHistory = true;
      const fallbackUser = userDisplayLabel === "考え中" ? "（音声で質問）" : userDisplayLabel;
      history.push({ role: "user", content: heard || fallbackUser });
      history.push({ role: "assistant", content: fullReply.trim() });
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj),
        signal: activeAbort.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error("音声ストリームの開始に失敗しました。");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let sseBuf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done || myGen !== generationId) break;

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
            setOrbState("thinking", ev.text || "Web検索中…");
          } else if (ev.type === "token") {
            fullReply += ev.text;
            aiTextEl.textContent = fullReply;
          } else if (ev.type === "done") {
            if (ev.full_text) {
              fullReply = ev.full_text;
              aiTextEl.textContent = fullReply;
            }
            if (ev.heard_text) {
              userTextEl.textContent = ev.heard_text;
            }
            commitHistory(ev.heard_text || "");
            onRagUpdated();

            if (ev.quiz_trigger && window.QuizSpace) {
              const qt = ev.quiz_trigger;
              pendingNavAction = () => {
                close();
                window.QuizSpace.openAndGenerate(qt.topic, qt.count || 3);
              };
            } else if (ev.book_trigger && window.BookSpace) {
              const bt = ev.book_trigger;
              pendingNavAction = () => {
                close();
                if (bt.topic && window.BookSpace.openAndCreate) {
                  window.BookSpace.openAndCreate(bt.topic);
                } else {
                  window.BookSpace.open();
                }
              };
            }
          } else if (ev.type === "error") {
            showError(ev.message || "応答エラーが発生しました。");
          }
        }
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        // 途中割り込みされても直前までの会話内容は履歴へ残す
        commitHistory("");
      } else {
        showError(err instanceof Error ? err.message : "通信エラーが発生しました。");
      }
    } finally {
      commitHistory("");
      if (myGen === generationId) {
        activeAbort = null;
        if (pendingNavAction) {
          const fn = pendingNavAction;
          pendingNavAction = null;
          setTimeout(fn, 350);
        } else if (micActive) {
          setOrbState("listening", "聞き取り中… そのまま話しかけてください（Gemma 4 直接音声認識）");
        } else {
          setOrbState("idle", "待機中");
        }
      }
    }
  }

  function sendUtterance(text) {
    const clean = text.trim();
    if (!clean) return;
    consumeSseReply(
      "/api/voice/ask_stream",
      { question: clean, history: history.slice(-6) },
      clean
    );
  }

  // Float32 PCM チャンク配列を 16kHz 16-bit モノラル WAV に変換して Base64 化
  function encodeWav16kBase64(chunks, inputSampleRate) {
    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    const targetRate = 16000;
    const ratio = inputSampleRate / targetRate;
    const outLen = Math.max(1, Math.floor(merged.length / ratio));
    const pcm = new Int16Array(outLen);

    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(merged.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += merged[j];
      const s = Math.max(-1, Math.min(1, sum / (end - start)));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    const buffer = new ArrayBuffer(44 + pcm.length * 2);
    const dv = new DataView(buffer);
    const writeStr = (off, str) => {
      for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i));
    };

    writeStr(0, "RIFF");
    dv.setUint32(4, 36 + pcm.length * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, 1, true); // mono
    dv.setUint32(24, targetRate, true);
    dv.setUint32(28, targetRate * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    writeStr(36, "data");
    dv.setUint32(40, pcm.length * 2, true);

    for (let i = 0; i < pcm.length; i++) {
      dv.setInt16(44 + i * 2, pcm[i], true);
    }

    const bytes = new Uint8Array(buffer);
    let binary = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  async function loadMicDevices(requestPermissionIfEmpty = false) {
    if (!navigator.mediaDevices?.enumerateDevices || !micSelect) return;
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      let inputs = devices.filter((d) => d.kind === "audioinput");

      if (requestPermissionIfEmpty && inputs.every((d) => !d.label)) {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach((t) => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
        inputs = devices.filter((d) => d.kind === "audioinput");
      }

      micSelect.innerHTML = '<option value="">既定のマイク</option>';
      inputs.forEach((d, idx) => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || `マイク ${idx + 1}`;
        micSelect.appendChild(opt);
      });

      if (selectedMicId && inputs.some((d) => d.deviceId === selectedMicId)) {
        micSelect.value = selectedMicId;
      } else {
        micSelect.value = "";
      }
    } catch {}
  }

  function stopMicStream() {
    if (micMeterFill) micMeterFill.style.width = "0%";
    if (processorNode) {
      try { processorNode.disconnect(); } catch {}
      processorNode = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch {}
      audioCtx = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    preRollChunks = [];
    speechChunks = [];
    isRecordingSpeech = false;
  }

  async function startMic() {
    clearError();
    stopMicStream();
    if (!navigator.mediaDevices?.getUserMedia) {
      const hint = window.isSecureContext
        ? "このブラウザではマイク入力が利用できません（SafariまたはChromeの最新版をお試しください）。"
        : "保護されたHTTPS証明書でないためブラウザがマイクをブロックしています（自己署名証明書はiPhoneでマイクが制限されることがあります）。";
      showError(hint);
      return;
    }

    try {
      const constraints = selectedMicId
        ? { audio: { deviceId: { exact: selectedMicId }, echoCancellation: true, noiseSuppression: true } }
        : { audio: { echoCancellation: true, noiseSuppression: true } };
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch {
        // 指定マイクや詳細オプションがスマホで非対応の場合は最小指定で再試行
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      await loadMicDevices(false);
    } catch (err) {
      const code = err?.name ? ` (${err.name})` : "";
      showError(`マイクを開けませんでした${code}。ブラウザの設定でマイク権限を許可してください。`);
      return;
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    if (audioCtx.state === "suspended") {
      try { await audioCtx.resume(); } catch {}
    }
    const src = audioCtx.createMediaStreamSource(mediaStream);
    processorNode = audioCtx.createScriptProcessor(4096, 1, 1);

    const VOICE_RMS_THRESHOLD = 0.018;
    const SILENCE_MS = 900;
    const MIN_SPEECH_MS = 350;
    const MAX_SPEECH_MS = 14000;

    processorNode.onaudioprocess = (ev) => {
      if (!micActive) return;
      const input = ev.inputBuffer.getChannelData(0);
      let sumSq = 0;
      for (let i = 0; i < input.length; i++) sumSq += input[i] * input[i];
      const rms = Math.sqrt(sumSq / input.length);

      if (micMeterFill) {
        micMeterFill.style.width = `${Math.min(100, Math.round(rms * 550))}%`;
      }

      const chunkCopy = new Float32Array(input);
      const now = performance.now();

      // AIが考え中・応答中でも、ユーザーが話しかけたら即座に途中割り込み（Barge-in）
      if (activeAbort) {
        preRollChunks.push(chunkCopy);
        if (preRollChunks.length > 4) preRollChunks.shift();

        if (rms > VOICE_RMS_THRESHOLD * 2.1) {
          bargeInFrames++;
          if (bargeInFrames >= 2) {
            bargeInFrames = 0;
            interruptSpeaking();
            isRecordingSpeech = true;
            speechStartAt = now;
            lastVoiceAt = now;
            speechChunks = [...preRollChunks];
            preRollChunks = [];
            setOrbState("listening", "割り込みを検知！声を録音中…");
          }
        } else {
          bargeInFrames = 0;
        }
        return;
      }

      bargeInFrames = 0;

      if (!isRecordingSpeech) {
        preRollChunks.push(chunkCopy);
        if (preRollChunks.length > 4) preRollChunks.shift();

        if (rms > VOICE_RMS_THRESHOLD) {
          isRecordingSpeech = true;
          speechStartAt = now;
          lastVoiceAt = now;
          speechChunks = [...preRollChunks];
          preRollChunks = [];
          setOrbState("listening", "声を録音中…（話し終わると自動で送信します）");
        }
      } else {
        speechChunks.push(chunkCopy);
        if (rms > VOICE_RMS_THRESHOLD * 0.75) {
          lastVoiceAt = now;
        }

        const silentFor = now - lastVoiceAt;
        const duration = now - speechStartAt;

        if (silentFor >= SILENCE_MS || duration >= MAX_SPEECH_MS) {
          const captured = speechChunks;
          isRecordingSpeech = false;
          speechChunks = [];

          if (duration >= MIN_SPEECH_MS && captured.length > 0 && audioCtx) {
            const b64 = encodeWav16kBase64(captured, audioCtx.sampleRate);
            consumeSseReply(
              "/api/voice/ask_audio_stream",
              { audio_b64: b64, history: history.slice(-6) },
              "考え中"
            );
          } else {
            setOrbState("listening", "聞き取り中… そのまま話しかけてください（Gemma 4 直接音声認識）");
          }
        }
      }
    };

    src.connect(processorNode);
    processorNode.connect(audioCtx.destination);

    micActive = true;
    micBtn.classList.add("is-active");
    micBtn.textContent = "マイクOFF（停止）";
    setOrbState("listening", "聞き取り中… そのまま話しかけてください（Gemma 4 直接音声認識）");
  }

  function stopMic() {
    micActive = false;
    micBtn.classList.remove("is-active");
    micBtn.textContent = "マイクON（会話開始）";
    stopMicStream();
    if (!activeAbort) {
      setOrbState("idle", "マイクボタンを押して会話を開始");
    }
  }

  function open() {
    view.hidden = false;
    clearError();
    loadMicDevices(false);
  }

  function close() {
    stopMic();
    interruptSpeaking();
    view.hidden = true;
  }

  backBtn?.addEventListener("click", close);

  micSelect?.addEventListener("change", () => {
    selectedMicId = micSelect.value;
    localStorage.setItem(STORAGE_MIC_KEY, selectedMicId);
    if (micActive) {
      stopMic();
      startMic();
    }
  });

  micRefreshBtn?.addEventListener("click", () => {
    loadMicDevices(true);
  });

  micBtn?.addEventListener("click", () => {
    if (micActive) stopMic();
    else startMic();
  });

  interruptBtn?.addEventListener("click", interruptSpeaking);

  textForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = textInput.value.trim();
    if (!val) return;
    textInput.value = "";
    sendUtterance(val);
  });

  return { open, close, setOnRagUpdated };
})();
