#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "===================================================="
echo "  Gakumon - Linux Environment & Model Setup"
echo "===================================================="

if ! command -v python3 >/dev/null 2>&1; then
  echo "[ERROR] python3 (3.10+) was not found. Please install python3 and python3-venv."
  exit 1
fi

if ! python3 -m venv --help >/dev/null 2>&1; then
  echo "[ERROR] python3-venv がありません。sudo apt install python3-venv を実行してから、もう一度 ./setup.sh を実行してください。"
  exit 1
fi

if [ ! -x ".venv/bin/python" ]; then
  echo "[Step 1] Creating Python virtual environment (.venv)..."
  if ! python3 -m venv .venv; then
    rm -rf .venv
    echo "[ERROR] python3-venv がありません。sudo apt install python3-venv を実行してから、もう一度 ./setup.sh を実行してください。"
    exit 1
  fi
fi

echo "[Step 2] Installing required Python packages..."
.venv/bin/python -m pip install --no-cache-dir --upgrade pip --quiet
.venv/bin/python -m pip install --no-cache-dir -r requirements.txt

echo ""
echo "[Step 3] Downloading llama.cpp Linux runtime and Gemma 4 / EmbeddingGemma 2 models..."
.venv/bin/python scripts/setup_env.py "$@"

chmod +x setup.sh start.sh stop.sh 2>/dev/null || true

echo ""
echo "===================================================="
echo "  Setup Complete! Run ./start.sh to launch Gakumon."
echo "===================================================="
