"""学萌 (Gakumon) ワンクリック環境構築・モデル自動ダウンロードスクリプト（Windows / Linux 対応）。"""
import io
import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNTIME_DIR = ROOT / "runtime"
MODELS_DIR = ROOT / "models"
LLM_DIR = MODELS_DIR / "gemma4-12b"
EMBED_DIR = MODELS_DIR / "embeddinggemma-2"

# Hugging Face キャッシュも含めてすべてこのフォルダ内に完結させる
os.environ["HF_HOME"] = str(MODELS_DIR / ".hf_cache")
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")

import httpx
from huggingface_hub import hf_hub_download

LLM_REPO = "unsloth/gemma-4-12B-it-qat-GGUF"
LLM_MODEL_FILE = "gemma-4-12B-it-qat-UD-Q4_K_XL.gguf"
LLM_MMPROJ_FILE = "mmproj-F16.gguf"
LLM_MTP_FILE = "MTP/mtp-gemma-4-12B-it-Q4_0.gguf"

EMBED_REPO = "ggml-org/embeddinggemma-2-GGUF"
EMBED_MODEL_FILE = "embeddinggemma-2-Q8_0.gguf"

IS_WIN = sys.platform.startswith("win")


def check_prerequisites(use_vulkan: bool = False, use_rocm: bool = False) -> None:
    missing: list[str] = []

    if IS_WIN:
        sys32 = Path(os.environ.get("WINDIR", r"C:\Windows")) / "System32"
        req_dlls = ("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll")
        if any(not (sys32 / dll).exists() for dll in req_dlls):
            missing.append(
                "Visual C++ 再頒布可能パッケージ（x64）を "
                "https://aka.ms/vs/17/release/vc_redist.x64.exe から入れてください。"
            )
    else:
        _, glibc_ver = platform.libc_ver()
        if glibc_ver:
            try:
                parts = tuple(int(x) for x in glibc_ver.split(".")[:2])
                if parts < (2, 38):
                    missing.append(
                        f"glibc {glibc_ver} は古いため動作しません（2.38 以上が必要）。"
                        "Ubuntu 24.04 以降を使ってください。"
                    )
            except ValueError:
                pass

    if not use_vulkan and not use_rocm:
        if not shutil.which("nvidia-smi"):
            if IS_WIN:
                missing.append(
                    "NVIDIA ドライバが見つかりません。"
                    "https://www.nvidia.com/ja-jp/drivers/ から NVIDIA ドライバを入れてください。"
                )
            else:
                missing.append(
                    "NVIDIA ドライバが見つかりません。"
                    "sudo ubuntu-drivers install を実行して再起動してください。"
                )

    if missing:
        print("\n[ERROR] セットアップの前に、以下を準備してください：")
        for item in missing:
            print(f"  - {item}")
        sys.exit(1)


def detect_win_cuda_tag() -> str:
    """Windows NVIDIA ドライバのバージョンから CUDA 13.5 / 12.4 版を選択する。"""
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
            text=True,
            timeout=5,
            stderr=subprocess.DEVNULL,
        ).strip()
        first_line = out.splitlines()[0].strip() if out else ""
        major = int(first_line.split(".")[0]) if first_line else 0
        if major >= 580:
            print(f"  Detected NVIDIA driver {first_line} (>= 580) -> selecting CUDA 13.5 build.")
            return "13.5"
        print(f"  Detected NVIDIA driver {first_line} (< 580) -> selecting CUDA 12.4 build.")
        return "12.4"
    except Exception:
        print("  Could not read NVIDIA driver version -> defaulting to CUDA 12.4 build.")
        return "12.4"


def download_bytes(url: str, label: str) -> io.BytesIO:
    print(f"  Downloading {label} ...")
    with httpx.Client(follow_redirects=True, timeout=300.0) as client:
        with client.stream("GET", url) as resp:
            resp.raise_for_status()
            total = int(resp.headers.get("content-length", 0))
            buf = io.BytesIO()
            done = 0
            for chunk in resp.iter_bytes(chunk_size=1024 * 512):
                buf.write(chunk)
                done += len(chunk)
                if total > 0:
                    pct = int(done * 100 / total)
                    print(
                        f"\r    {pct:3d}% ({done // (1024 * 1024)} / {total // (1024 * 1024)} MB)",
                        end="",
                        flush=True,
                    )
            print()
            buf.seek(0)
            return buf


def download_and_extract(url: str, dest: Path, label: str) -> None:
    buf = download_bytes(url, label)
    if label.endswith(".zip"):
        with zipfile.ZipFile(buf) as zf:
            zf.extractall(dest)
    elif label.endswith((".tar.gz", ".tgz")):
        with tarfile.open(fileobj=buf, mode="r:gz") as tf:
            if hasattr(tarfile, "data_filter"):
                tf.extractall(dest, filter="data")
            else:
                tf.extractall(dest)
    else:
        raise RuntimeError(f"Unsupported archive format: {label}")


def find_llama_server() -> Path | None:
    exe_name = "llama-server.exe" if IS_WIN else "llama-server"
    direct = RUNTIME_DIR / exe_name
    if direct.exists():
        return direct
    found = list(RUNTIME_DIR.rglob(exe_name))
    return found[0] if found else None


def setup_llama_runtime(use_vulkan: bool = False, use_rocm: bool = False) -> None:
    existing = find_llama_server()
    if existing:
        print(f"[1/4] llama.cpp runtime already exists: {existing}")
        return

    os_label = "Windows" if IS_WIN else "Linux"
    print(f"[1/4] Downloading latest llama.cpp {os_label} runtime from GitHub...")
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    rels = httpx.get(
        "https://api.github.com/repos/ggml-org/llama.cpp/releases",
        params={"per_page": 10},
        timeout=20.0,
    ).json()

    win_cuda_ver = detect_win_cuda_tag() if (IS_WIN and not use_vulkan) else "12.4"

    main_asset = None
    cudart_asset = None
    for rel in rels:
        assets = rel.get("assets", [])
        if IS_WIN:
            if use_vulkan:
                for a in assets:
                    n = a.get("name", "")
                    if "bin-win-vulkan-x64.zip" in n and n.startswith("llama-"):
                        main_asset = a
                        break
            else:
                main_suffix = f"bin-win-cuda-{win_cuda_ver}-x64.zip"
                cudart_name = f"cudart-llama-bin-win-cuda-{win_cuda_ver}-x64.zip"
                for a in assets:
                    n = a.get("name", "")
                    if main_suffix in n and n.startswith("llama-"):
                        main_asset = a
                    elif cudart_name in n:
                        cudart_asset = a
        else:
            if use_vulkan:
                for a in assets:
                    n = a.get("name", "")
                    if "bin-ubuntu-vulkan-x64.tar.gz" in n and n.startswith("llama-"):
                        main_asset = a
                        break
            elif use_rocm:
                for a in assets:
                    n = a.get("name", "")
                    if "bin-ubuntu-rocm-" in n and n.endswith("-x64.tar.gz") and n.startswith("llama-"):
                        main_asset = a
                        break
            else:
                for a in assets:
                    n = a.get("name", "")
                    if "bin-ubuntu-cuda-12.8-x64.tar.gz" in n and n.startswith("llama-"):
                        main_asset = a
                    elif "bin-ubuntu-cuda-12.8-x64.tar.gz" in n and n.startswith("cudart-llama-"):
                        cudart_asset = a
        if main_asset:
            print(f"  Found release: {rel.get('tag_name')} ({main_asset.get('name')})")
            break

    if not main_asset:
        raise RuntimeError(f"Could not find llama.cpp {os_label} binary asset on GitHub.")

    download_and_extract(main_asset["browser_download_url"], RUNTIME_DIR, main_asset["name"])
    if cudart_asset and not use_vulkan and not use_rocm:
        download_and_extract(cudart_asset["browser_download_url"], RUNTIME_DIR, cudart_asset["name"])

    server_path = find_llama_server()
    if not server_path:
        raise RuntimeError("llama-server binary was not found after extraction.")
    if not IS_WIN:
        server_path.chmod(server_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        # Linux CUDA: cudart-llama-* サブフォルダ内の .so* を llama-server と同じフォルダにもコピー
        server_dir = server_path.parent
        for cudart_dir in RUNTIME_DIR.glob("cudart-llama-*"):
            if not cudart_dir.is_dir():
                continue
            for so_file in cudart_dir.rglob("*.so*"):
                if not (so_file.is_file() or so_file.is_symlink()):
                    continue
                dest_so = server_dir / so_file.name
                if dest_so.exists() or dest_so.is_symlink():
                    dest_so.unlink()
                shutil.copy2(so_file, dest_so, follow_symlinks=False)
    print(f"  Runtime ready: {server_path}")


def setup_llm_model() -> None:
    LLM_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[2/4] Downloading Gemma 4 12B QAT + mmproj + MTP ({LLM_REPO})...")
    for filename in (LLM_MODEL_FILE, LLM_MMPROJ_FILE, LLM_MTP_FILE):
        target = LLM_DIR / filename
        if target.exists():
            print(f"  Already exists: {filename}")
            continue
        print(f"  Fetching {filename} ...")
        hf_hub_download(
            repo_id=LLM_REPO,
            filename=filename,
            local_dir=str(LLM_DIR),
        )
    print("  Gemma 4 12B QAT + MTP ready.")


def setup_embed_model() -> None:
    EMBED_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[3/4] Downloading EmbeddingGemma 2 ({EMBED_REPO})...")
    target = EMBED_DIR / EMBED_MODEL_FILE
    if target.exists():
        print(f"  Already exists: {EMBED_MODEL_FILE}")
    else:
        hf_hub_download(
            repo_id=EMBED_REPO,
            filename=EMBED_MODEL_FILE,
            local_dir=str(EMBED_DIR),
        )
    print("  EmbeddingGemma 2 ready.")


def setup_certs() -> None:
    print("[4/4] Checking local HTTPS certificate...")
    cert_file = ROOT / "certs" / "cert.pem"
    key_file = ROOT / "certs" / "key.pem"
    if cert_file.exists() and key_file.exists():
        print("  HTTPS certificate already exists.")
        return
    sys.path.insert(0, str(ROOT))
    import gen_cert

    gen_cert.generate_self_signed_cert()


def main() -> None:
    use_vulkan = "--vulkan" in sys.argv
    use_rocm = "--rocm" in sys.argv
    print("==============================================")
    print("  Gakumon (学萌) - Automatic Environment Setup")
    print("==============================================")
    check_prerequisites(use_vulkan=use_vulkan, use_rocm=use_rocm)
    setup_llama_runtime(use_vulkan=use_vulkan, use_rocm=use_rocm)
    setup_llm_model()
    setup_embed_model()
    setup_certs()
    next_cmd = "start.bat" if IS_WIN else "./start.sh"
    print(f"\nAll setup steps completed! Run {next_cmd} to launch Gakumon.")


if __name__ == "__main__":
    main()
