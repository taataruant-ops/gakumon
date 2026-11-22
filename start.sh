#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

LOG_DIR="$APP_DIR/logs"
mkdir -p "$LOG_DIR"

PYTHON_BIN="$APP_DIR/.venv/bin/python"
if [ ! -x "$PYTHON_BIN" ]; then
  PYTHON_BIN="$(command -v python3)"
fi

LLAMA_BIN="$(find "$APP_DIR/runtime" -maxdepth 4 -type f -name 'llama-server' 2>/dev/null | head -n 1 || true)"
if [ -z "$LLAMA_BIN" ]; then
  echo "[ERROR] llama-server not found in runtime/. Please run ./setup.sh first."
  exit 1
fi
LLAMA_DIR="$(dirname "$LLAMA_BIN")"
CUDART_PATHS=""
for d in "$APP_DIR"/runtime/cudart-llama-*/; do
  [ -d "$d" ] && CUDART_PATHS="${d%/}:$CUDART_PATHS"
done
export LD_LIBRARY_PATH="$LLAMA_DIR:${CUDART_PATHS}$APP_DIR/runtime:${LD_LIBRARY_PATH:-}"

LLM_MODEL="$APP_DIR/models/gemma4-12b/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf"
LLM_MMPROJ="$APP_DIR/models/gemma4-12b/mmproj-F16.gguf"
LLM_MTP="$APP_DIR/models/gemma4-12b/MTP/mtp-gemma-4-12B-it-Q4_0.gguf"
CHAT_TPL="$APP_DIR/scripts/gemma4-concise.jinja"
EMBED_MODEL="$APP_DIR/models/embeddinggemma-2/embeddinggemma-2-Q8_0.gguf"

is_listening() {
  local port="$1"
  "$PYTHON_BIN" -c "import socket,sys; s=socket.socket(); s.settimeout(0.5); sys.exit(0 if s.connect_ex(('127.0.0.1',$port))==0 else 1)"
}

is_healthy() {
  local port="$1"
  "$PYTHON_BIN" -c "import json,sys,urllib.request
try:
    sys.exit(0 if json.load(urllib.request.urlopen('http://127.0.0.1:$port/health', timeout=2)).get('status')=='ok' else 1)
except Exception:
    sys.exit(1)"
}

# 1. EmbeddingGemma 2 (CPU mode, 0 VRAM, port 8790)
if ! is_listening 8790; then
  echo "Starting EmbeddingGemma 2 (CPU mode) on port 8790..."
  CUDA_VISIBLE_DEVICES="" nohup "$LLAMA_BIN" \
    -m "$EMBED_MODEL" \
    --embeddings \
    --host 127.0.0.1 --port 8790 \
    -c 8192 -b 8192 -ub 8192 \
    -ngl 0 \
    >"$LOG_DIR/embed.out" 2>"$LOG_DIR/embed.err" &
  EMBED_PID=$!
  echo "$EMBED_PID" >"$LOG_DIR/embed.pid"

  EMBED_OK=0
  for _ in $(seq 1 120); do
    if ! kill -0 "$EMBED_PID" 2>/dev/null; then
      echo "[ERROR] EmbeddingGemma 2 exited early. logs/embed.err を見てください。"
      exit 1
    fi
    if is_healthy 8790; then
      EMBED_OK=1
      break
    fi
    sleep 0.5
  done
  if [ "$EMBED_OK" -ne 1 ]; then
    echo "[ERROR] EmbeddingGemma 2 の起動がタイムアウトしました。logs/embed.err を見てください。"
    exit 1
  fi
  echo "EmbeddingGemma 2 ready: http://127.0.0.1:8790/v1/embeddings (PID $EMBED_PID)"
else
  echo "EmbeddingGemma 2 already listening on port 8790."
fi

# 2. Gemma 4 12B QAT + MTP (GPU mode, port 8770, 4 parallel slots)
if ! is_listening 8770; then
  DEVICES="$("$LLAMA_BIN" --list-devices 2>&1 || true)"
  if ! echo "$DEVICES" | grep -Eq '^\s*(CUDA|Vulkan|ROCm)[0-9]+:'; then
    echo ""
    echo "[WARNING] GPU が見つかりません。Gemma 4 は CPU で動くため、とても遅くなります。"
    echo "NVIDIA ドライバが入っているか確認し、だめなら ./setup.sh をやり直してください。"
    echo ""
  fi

  echo "Starting Gemma 4 12B QAT + MTP (GPU mode) on port 8770..."
  LLM_ARGS=(
    -m "$LLM_MODEL"
    --alias gemma4-12b
    --host 127.0.0.1 --port 8770
    -ngl 99 -fa on -c 131072 -np 4
    --jinja
    --reasoning auto
    --reasoning-format deepseek
    --reasoning-budget 150
    --reasoning-budget-message "ここまでにして結論を書く。"
    --reasoning-effort medium
  )
  [ -f "$CHAT_TPL" ] && LLM_ARGS+=(--chat-template-file "$CHAT_TPL")
  [ -f "$LLM_MMPROJ" ] && LLM_ARGS+=(--mmproj "$LLM_MMPROJ")
  [ -f "$LLM_MTP" ] && LLM_ARGS+=(--model-draft "$LLM_MTP" -ngld 99 --spec-type "draft-mtp,ngram-simple" --spec-draft-n-max 4)

  nohup "$LLAMA_BIN" "${LLM_ARGS[@]}" >"$LOG_DIR/llm.out" 2>"$LOG_DIR/llm.err" &
  LLM_PID=$!
  echo "$LLM_PID" >"$LOG_DIR/llm.pid"

  LLM_OK=0
  for _ in $(seq 1 600); do
    if ! kill -0 "$LLM_PID" 2>/dev/null; then
      echo "[ERROR] Gemma 4 12B exited early. logs/llm.err を見てください。"
      exit 1
    fi
    if is_healthy 8770; then
      LLM_OK=1
      break
    fi
    sleep 0.5
  done
  if [ "$LLM_OK" -ne 1 ]; then
    echo "[ERROR] Gemma 4 12B の起動がタイムアウトしました。logs/llm.err を見てください。"
    exit 1
  fi
  echo "Gemma 4 12B ready: http://127.0.0.1:8770/v1 (PID $LLM_PID)"
else
  echo "Gemma 4 12B server already listening on port 8770."
fi

# 3. Web UI (FastAPI HTTPS on 0.0.0.0:8000)
CERT_FILE="$APP_DIR/certs/cert.pem"
KEY_FILE="$APP_DIR/certs/key.pem"
if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  "$PYTHON_BIN" "$APP_DIR/gen_cert.py"
fi

if ! is_listening 8000; then
  echo "Starting Gakumon Web UI on https://0.0.0.0:8000 ..."
  nohup "$PYTHON_BIN" -m uvicorn app:app \
    --host 0.0.0.0 --port 8000 \
    --ssl-certfile "$CERT_FILE" \
    --ssl-keyfile "$KEY_FILE" \
    >"$LOG_DIR/web.out" 2>"$LOG_DIR/web.err" &
  WEB_PID=$!
  echo "$WEB_PID" >"$LOG_DIR/web.pid"

  WEB_OK=0
  for _ in $(seq 1 50); do
    if ! kill -0 "$WEB_PID" 2>/dev/null; then
      echo "[ERROR] Web UI exited early. logs/web.err を見てください。"
      exit 1
    fi
    if is_listening 8000; then
      WEB_OK=1
      break
    fi
    sleep 0.3
  done
  if [ "$WEB_OK" -ne 1 ]; then
    echo "[ERROR] Web UI の起動がタイムアウトしました。logs/web.err を見てください。"
    exit 1
  fi
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  echo "Web UI ready (HTTPS): https://127.0.0.1:8000 (PID $WEB_PID)"
  if [ -n "$LAN_IP" ]; then
    echo "LAN URL（同じネットワーク内のスマホから）: https://${LAN_IP}:8000"
  fi
else
  echo "Web UI already listening on port 8000."
fi
