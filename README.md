# 学萌（がくもん / Gakumon）

どうもたあたるだお。  
学校のAIがくそ過ぎたから自分専用にサイト作ったお。

以下AIによる使い方の説明

---

**圧倒的なプライバシーの保護 × 完全な学習機能。**  
AI推論・ベクトル検索（RAG）・学習データベースの保存をローカルPC内で完結させ、同じWi-Fi内のスマホ・タブレット・PCから最大4人同時利用できる次世代AI学習パートナーです。

Built with **Google Antigravity** / Powered by **Gemma 4 12B** + **EmbeddingGemma 2**

---

## プライバシーと通信の範囲について

- **ローカルPC内で完結する処理**：
  - LLM推論（`Gemma 4 12B`：テキスト・画像・音声の理解と生成）
  - 記憶のベクトル化・類似検索（`EmbeddingGemma 2`）
  - 会話履歴・RAG記憶・AI本の保存（ローカル SQLite `mistakes.db`）
  - 生徒の質問内容や手書きノート画像が外部のAIプロバイダへ送信されることはありません。
- **外部通信が発生する箇所**：
  - 初回 `setup.bat` / `setup.sh` 実行時のモデル・ランタイム取得（Hugging Face / GitHub Releases）
  - AIが最新情報を確認するために自律Web検索を実行した場合の検索クエリ・公開ページ取得（DuckDuckGo / プライベートIPは遮断）
  - ブラウザUI表示用のフォント読込（Google Fonts。オフライン時はPC内フォントへ自動フォールバック）

---

## 主な機能

- **質問モード（チャット＋画像＋リアルタイム文字ストリーミング）**
  - 分からない問題やスクリーンショットを送るだけで、過去の記憶（RAG）を参照しながら数式（KaTeX）付きで解説
  - 必要に応じて安全なWeb検索・期間指定の過去振り返りも自律実行
- **復習モード（S-CBT形式 苦手克服Webテスト）**
  - 過去のつまずき・RAG記憶から自分専用の4択テストを自動生成（タイマー・見直しフラグ・解説付き）
- **足跡モード（RAG空間マップ）**
  - これまでの質問と学習履歴を `EmbeddingGemma 2` でベクトル化し、2Dマップとして可視化（スマホ・タブレットの2本指ピンチ拡大対応）
- **教科書モード（AI本）**
  - 学んだ内容や過去のつまずきをまとめて、見開きページめくり対応の「自分専用教科書」を自動執筆・ページ追加
- **ノートモード（AIノート）**
  - iPad / Apple Pencil・スマホ・PCで手書きノートを取り、そのままAIに添削・質問可能
- **音声モード（Gemma 4 ネイティブ音声入力）**
  - 外部文字起こしAPIを使わず、録音音声を `Gemma 4 12B` に直接入力してリアルタイム応答（途中割り込み・Webテスト／AI本への音声ジャンプ対応）
- **複数人・Wi-Fi共有対応**
  - ユーザー名ごとにRAG記憶・AI本・チャット履歴を分離。ローカルPC 1台（例：RTX 5060 Ti 16GB）をサーバーにして家族や塾で同時4人まで利用可能

---

## 動作環境（推奨）

- **OS**: Windows 10 / 11 (64-bit) または Linux (Ubuntu 24.04 以降 x86_64)
- **GPU**: NVIDIA GPU（VRAM 16GB 以上推奨、例：RTX 5060 Ti 16GB）
  - ※ AMD / Intel GPU の場合は `--vulkan`（Linux AMD は `--rocm` も可）を付けてセットアップできます
- **ストレージ空き容量**: 約 12 GB（Gemma 4 12B QAT + mmproj + MTP + EmbeddingGemma 2 + llama.cpp）

---

## 先に入れておくもの

### Windows
- Python 3.10 以上（[python.org](https://www.python.org/downloads/) から。「Add python.exe to PATH」にチェック）
- NVIDIA ドライバ（RTX 50 シリーズはドライバ 580 以降を推奨）
- Visual C++ 再頒布可能パッケージ x64（https://aka.ms/vs/17/release/vc_redist.x64.exe）  
  ※ 多くの PC には入っています。足りないときは `setup.bat` が教えてくれます。

### Linux（Ubuntu 24.04 以降）
```bash
sudo apt install python3 python3-venv
sudo ubuntu-drivers install   # NVIDIA ドライバ（入っていなければ。入れたら再起動）
```
- Ubuntu 22.04 / Debian 12 では `llama.cpp` が動かないため対象外です（glibc 2.38 以上が必要）。

---

## ワンクリック環境構築＆起動方法

### Windows の場合
0. このページ右上の緑の **「Code」→「Download ZIP」** でダウンロードし、ZIP を右クリック → **「すべて展開」** する  
   （※ 展開したフォルダの中の `setup.bat` を使ってください。ZIP の中のまま実行しないでください）
1. **`setup.bat`** をダブルクリック（初回のみ：`.venv`・`llama.cpp` CUDA ランタイム・モデル一式・HTTPS証明書を自動構築）
2. **`start.bat`** をダブルクリック（起動して自動で `https://127.0.0.1:8000` が開きます）
3. 終了するときは **`stop.bat`** をダブルクリック

### Linux（Ubuntu 等）の場合
```bash
git clone https://github.com/taataruant-ops/gakumon.git
cd gakumon
chmod +x setup.sh start.sh stop.sh
./setup.sh        # 初回のみ（AMD/Intel GPU は ./setup.sh --vulkan または --rocm）
./start.sh        # 起動（https://127.0.0.1:8000 および LAN IP:8000）
./stop.sh         # 終了
```

### 自動ダウンロードされる内容（Windows / Linux 共通）
- Python仮想環境（`.venv`）＆必要ライブラリ（`requirements.txt`）
- 公式 `llama.cpp` ランタイム（Windows CUDA 13.5 / 12.4 自動選択、Linux CUDA 12.8）→ `runtime/`
- **Gemma 4 12B QAT + MTP**（`unsloth/gemma-4-12B-it-qat-GGUF`：`gemma-4-12B-it-qat-UD-Q4_K_XL.gguf` + `mmproj-F16.gguf` + `MTP/mtp-gemma-4-12B-it-Q4_0.gguf`）→ `models/gemma4-12b/`
- **EmbeddingGemma 2**（`ggml-org/embeddinggemma-2-GGUF`：`embeddinggemma-2-Q8_0.gguf`）→ `models/embeddinggemma-2/`
- ローカルHTTPS自己署名証明書 → `certs/`

### 同じ Wi-Fi のスマホ・タブレットから開くときの注意
- 起動時に表示される `https://<PCのIP>:8000` にアクセスしてください（初回のみ自己署名証明書の警告を「詳細設定 → アクセスする」で通過）。
- 初回の起動時に「Windows セキュリティの重要な警告（Python）」が出たら、**「プライベート ネットワーク」** にチェックを入れて **「アクセスを許可する」** を押してください。許可しないと、同じ Wi-Fi のスマホやタブレットから学萌を開けません。
- Linux で `ufw` を使っている場合は、`sudo ufw allow 8000/tcp` でポート 8000 を開けてください。

---

## 環境変数（既存の OpenAI 互換サーバーを使う場合）

すでに独自のローカル OpenAI 互換サーバーをポート `8770` や `8790` で動かしている場合は、以下の環境変数で接続先やモデル名を変更できます：

| 環境変数 | デフォルト値 | 説明 |
| --- | --- | --- |
| `GAKUMON_LLM_URL` | `http://127.0.0.1:8770/v1` | LLMサーバーのOpenAI互換エンドポイント |
| `GAKUMON_EMBED_URL` | `http://127.0.0.1:8790/v1` | Embeddingサーバーのエンドポイント |
| `GAKUMON_LLM_MODEL` | `gemma4-12b` | リクエスト時に指定するモデル名 |
| `SIMILARITY_THRESHOLD` | `0.62` | RAG類似検索の初期しきい値 |

---

## 技術構成

| コンポーネント | 技術 |
| --- | --- |
| LLM（テキスト・画像・音声） | Gemma 4 12B QAT（UD-Q4_K_XL）+ MTP 投機的デコード (`llama.cpp` / 4並列スロット) |
| ベクトル埋め込み（RAG） | EmbeddingGemma 2 (`llama.cpp` CPUモード / 0 VRAM) |
| バックエンド | FastAPI + SQLite (`mistakes.db`) + SSEストリーミング |
| フロントエンド | Vanilla JS + HTML5 Canvas + KaTeX（PC / iPad / iPhone レスポンシブ対応） |
| 開発ツール | 100% Google Antigravity |
| ライセンス | MIT License ([LICENSE](./LICENSE)) |

---

## ライセンス

- 学萌のソースコード：MIT License（[LICENSE](./LICENSE)）
- AIモデル（Gemma 4 12B / EmbeddingGemma 2）：Google の Gemma 利用規約に従います（https://ai.google.dev/gemma/terms）
- llama.cpp：MIT License（https://github.com/ggml-org/llama.cpp）
- KaTeX：MIT License（[static/vendor/katex/LICENSE](./static/vendor/katex/LICENSE)）
- 本アプリはモデル本体を同梱していません。`setup.bat` / `setup.sh` が Hugging Face から各自の PC にダウンロードします。
