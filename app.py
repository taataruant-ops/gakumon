import asyncio
from datetime import datetime
import ipaddress
import json
import os
import random
import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from bs4 import BeautifulSoup
from ddgs import DDGS
import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db

LLM_BASE_URL = os.getenv("GAKUMON_LLM_URL", "http://127.0.0.1:8770/v1")
EMBED_BASE_URL = os.getenv("GAKUMON_EMBED_URL", "http://127.0.0.1:8790/v1")
LLM_MODEL = os.getenv("GAKUMON_LLM_MODEL", "gemma4-12b")
SIMILARITY_THRESHOLD = float(os.getenv("SIMILARITY_THRESHOLD", "0.62"))

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="学萌")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.on_event("startup")
def on_startup() -> None:
    db.init_db()


def get_request_user(x_user_name: str | None = Header(default=None, alias="X-User-Name")) -> str:
    if not x_user_name:
        return db.DEFAULT_USER
    try:
        decoded = unquote(x_user_name)
    except Exception:
        decoded = x_user_name
    return db.normalize_user(decoded)


class AskRequest(BaseModel):
    question: str = ""
    image_data: str = ""
    threshold: float | None = None
    history: list[dict[str, str]] = []


class MistakeCreateRequest(BaseModel):
    question_text: str
    mistake_point: str
    subject_tag: str = ""
    explanation: str = ""
    image_data: str = ""


class QuizGenerateRequest(BaseModel):
    topic: str
    count: int = 3


class VoiceAskRequest(BaseModel):
    question: str
    threshold: float | None = None
    history: list[dict[str, str]] = []


class VoiceAudioAskRequest(BaseModel):
    audio_b64: str
    history: list[dict[str, str]] = []


class NoteIndexRequest(BaseModel):
    title: str = "手書きノート"
    page: int = 1
    image_data: str


class BookCreateRequest(BaseModel):
    topic: str


class BookAddPageRequest(BaseModel):
    instruction: str = ""


async def check_server(url: str) -> bool:
    base = url.removesuffix("/v1")
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            for endpoint in (f"{base}/health", f"{url}/models"):
                try:
                    resp = await client.get(endpoint)
                    if resp.status_code == 200:
                        return True
                except Exception:
                    continue
            return False
    except Exception:
        return False


async def get_embedding(text: str, *, is_query: bool, title: str = "none") -> list[float]:
    clean = text.strip()
    if not clean:
        raise HTTPException(status_code=400, detail="検索・保存するテキストが空です。")

    prefix_text = (
        f"task: search result | query: {clean}"
        if is_query
        else f"title: {title.strip() or 'none'} | text: {clean}"
    )

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{EMBED_BASE_URL}/embeddings",
                json={"model": "embeddinggemma-2", "input": [prefix_text]},
            )
            resp.raise_for_status()
            data = resp.json()
            return data["data"][0]["embedding"]
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"EmbeddingGemma 2 (port 8790) に接続できません: {exc}",
        ) from exc


async def call_gemma_chat(messages: list[dict[str, Any]], max_tokens: int = 1024) -> str:
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.post(
                f"{LLM_BASE_URL}/chat/completions",
                json={
                    "model": LLM_MODEL,
                    "messages": messages,
                    "max_tokens": max_tokens,
                    "temperature": 0.4,
                    "reasoning_effort": "high",
                    "reasoning_budget_tokens": 600,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"].strip()
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"ローカルLLMサーバー ({LLM_MODEL}) に接続できません: {exc}",
        ) from exc


async def transcribe_image_question(image_data: str) -> str:
    content: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": "画像に写っている問題文や数式・コードをそのまま文字起こしし、何の問題か1〜2文で簡潔に記述してください。解説は不要です。",
        },
        {"type": "image_url", "image_url": {"url": image_data}},
    ]
    return await call_gemma_chat([{"role": "user", "content": content}], max_tokens=256)


def _is_safe_public_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return False
        host = (parsed.hostname or "").lower()
        if not host or host in ("localhost",) or host.endswith(".local"):
            return False
        try:
            ip = ipaddress.ip_address(host)
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return False
        except ValueError:
            pass
        return True
    except Exception:
        return False


def _ddgs_search_sync(query: str, max_results: int = 4) -> list[dict[str, str]]:
    results = DDGS().text(query, region="jp-jp", max_results=max_results) or []
    out: list[dict[str, str]] = []
    for r in results:
        href = str(r.get("href") or "").strip()
        title = str(r.get("title") or "").strip()
        body = str(r.get("body") or "").strip()
        if href and _is_safe_public_url(href):
            out.append({"title": title, "url": href, "snippet": body[:240]})
    return out


async def run_web_search(query: str) -> list[dict[str, str]]:
    try:
        return await asyncio.to_thread(_ddgs_search_sync, query, 4)
    except Exception:
        return []


async def fetch_page_excerpt(url: str, max_chars: int = 1200) -> str:
    if not _is_safe_public_url(url):
        return ""
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            resp = await client.get(
                url,
                headers={"User-Agent": "Mozilla/5.0 (compatible; Gakumon-StudyTutor/1.0)"},
            )
            if resp.status_code != 200 or "text/html" not in (resp.headers.get("content-type") or ""):
                return ""
            soup = BeautifulSoup(resp.text, "html.parser")
            for tag in soup(["script", "style", "nav", "header", "footer", "aside"]):
                tag.decompose()
            text = re.sub(r"\s+", " ", soup.get_text(" ", strip=True))
            return text[:max_chars]
    except Exception:
        return ""


def extract_meta(raw_text: str, fallback_question: str) -> tuple[str, str, str, bool]:
    """解説本文とメタ行（単元・つまずき要点・RAG保存要否）を分離する。"""
    tag = ""
    point = ""
    lines = raw_text.splitlines()
    kept_lines: list[str] = []

    for line in lines:
        tag_match = re.match(r"^\s*【単元】\s*(.+)$", line)
        point_match = re.match(r"^\s*【つまずき要点】\s*(.+)$", line)
        if tag_match:
            tag = tag_match.group(1).strip()
        elif point_match:
            point = point_match.group(1).strip()
        else:
            kept_lines.append(line)

    explanation = "\n".join(kept_lines).strip()
    skip_rag = False
    if re.search(r"\[\[NO_RAG\]\]|必要なし|保存不要", point):
        skip_rag = True
        point = ""
    elif not point:
        point = fallback_question[:60].replace("\n", " ").strip()
    return explanation, tag, point, (not skip_rag)


SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "index.html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.get("/api/users")
async def list_users_endpoint() -> dict[str, Any]:
    return {"users": db.list_users()}


@app.get("/api/health")
async def health(user_name: str = Depends(get_request_user)) -> dict[str, Any]:
    llm_ok = await check_server(LLM_BASE_URL)
    embed_ok = await check_server(EMBED_BASE_URL)
    return {
        "llm_ok": llm_ok,
        "embed_ok": embed_ok,
        "user_name": user_name,
        "mistakes_count": len(db.list_mistakes(user_name=user_name)),
        "rag_count": len(db.list_rag_memories(user_name=user_name)),
    }


def format_memory_items(items: list[dict[str, Any]]) -> str:
    lines = []
    for idx, m in enumerate(items, 1):
        pct = round(m["similarity"] * 100)
        kind = "過去のつまずき" if m.get("source") == "mistake" else "過去の会話"
        dt = (m.get("created_at") or "")[:16]
        q_short = (m.get("question_text") or "").replace("\n", " ")[:100]
        point = (m.get("mistake_point") or "").replace("\n", " ")[:140]
        if not point and m.get("explanation"):
            point = m["explanation"].replace("\n", " ")[:140]
        lines.append(
            f"[{idx}] {dt} | {kind} (類似度{pct}% / {m.get('subject_tag') or '未分類'})\n"
            f"  質問: {q_short}\n"
            f"  要点: {point}"
        )
    return "\n".join(lines)


@app.post("/api/ask")
async def ask_question(req: AskRequest, user_name: str = Depends(get_request_user)) -> dict[str, Any]:
    question_text = req.question.strip()
    has_image = bool(req.image_data.strip())
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")

    if not question_text and not has_image:
        raise HTTPException(status_code=400, detail="問題文または画像を入力してください。")

    # 画像のみの場合は先に問題文を抽出して類似検索に使う
    search_text = question_text
    if not search_text and has_image:
        search_text = await transcribe_image_question(req.image_data)

    query_embedding = await get_embedding(search_text, is_query=True)
    min_score = req.threshold if req.threshold is not None else SIMILARITY_THRESHOLD
    similar = db.search_similar_memories(
        query_embedding,
        top_k=3,
        min_score=min_score,
        user_name=user_name,
    )

    past_context = ""
    if similar:
        past_context = (
            "<past_memory>\n"
            + format_memory_items(similar)
            + "\n</past_memory>\n"
            "※<past_memory>は意味が近い過去の記録（上位最大3件）です。現在の質問と関係がある項目だけ踏まえて回答し、無関係なら無視してください。\n\n"
        )

    system_prompt = (
        f"あなたは親しみやすく頼れる学習パートナーAI「学萌（がくもん）」です。現在日時は {now_str} です。\n"
        "問題の解説を求められたときは順を追ってわかりやすく丁寧に解説し、"
        "普通の会話・雑談・深掘りや追加の質問には自然な対話として親身に答えてください。\n"
        "【期間指定RAGの特殊タグ】\n"
        "ユーザーが「この前の」「昨日」「先週」「昔」「前に話した」など過去の時期を指定して思い出すよう求めた場合で、"
        "<past_memory>に該当する情報が見当たらないときは、他の文章を一切書かずに次の特殊タグだけを1行出力してください：\n"
        "[[TIME_RAG: start=YYYY-MM-DD, end=YYYY-MM-DD, topic=検索したい分野やキーワード]]\n\n"
        "【苦手克服テスト起動の特殊タグ】\n"
        "ユーザーが「〇〇の苦手克服問題を作って」「〇〇のテストを出して」「練習問題を作って」などテストや確認問題の作成を求めたときは、"
        "他の文章を一切書かずに次の特殊タグだけを1行出力してください（問題数指定がなければ count=3）：\n"
        "[[START_QUIZ: topic=分野やテーマ, count=3]]\n\n"
        "【Web検索エージェントの特殊タグ】\n"
        "最新の出来事・統計データ・正確な年号・人物・法律・制度など、Webで最新の事実を確認した方が正確に答えられる質問のときは、"
        "他の文章を一切書かずに次の特殊タグだけを1行出力してください：\n"
        "[[WEB_SEARCH: query=検索キーワード]]\n"
        "※計算問題や一般的な基礎概念・雑談など検索が不要な場合はタグを出さずそのまま答えてください。\n\n"
        "通常の回答をするときは、回答の最後に必ず次の2行だけを追加してください（本文とは別の行に書くこと）：\n"
        "【単元】話題の分野や単元名（雑談・挨拶の場合は「雑談・挨拶」など）\n"
        "【つまずき要点】このやりとりの要点や覚えておきたいポイントを1文で短く（ただし、挨拶・感謝・相槌など記憶に残す必要がないやりとりの場合は必ず [[NO_RAG]] とだけ書くこと）"
    )

    image_note = (
        "\n※画像が添付されています。まず図に書かれた頂点名・各辺の長さ・条件の対応を1つずつ正確に確認してから解答してください。"
        if has_image
        else ""
    )
    user_text = (
        f"現在日時: {now_str}\n"
        f"{past_context}"
        f"<current_question>\n{question_text or '（画像の内容について教えてください）'}{image_note}\n</current_question>"
    )

    if has_image:
        user_content: Any = [
            {"type": "text", "text": user_text},
            {"type": "image_url", "image_url": {"url": req.image_data}},
        ]
    else:
        user_content = user_text

    messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for h in req.history[-6:]:
        role = h.get("role")
        content = (h.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content[:1500]})
    messages.append({"role": "user", "content": user_content})

    raw_answer = await call_gemma_chat(messages, max_tokens=2048)
    agent_steps: list[str] = []
    web_sources: list[dict[str, str]] = []

    # 特殊タグ [[WEB_SEARCH: query=...]] を検出したら安全なWeb検索＋上位ページ本文確認を実行して再回答
    web_match = re.search(r"\[\[WEB_SEARCH:\s*query=([^\]]+)\]\]", raw_answer)
    if web_match:
        search_q = web_match.group(1).strip()
        agent_steps.append(f"Web検索: {search_q}")
        hits = await run_web_search(search_q)
        web_context_lines: list[str] = []
        for idx, h in enumerate(hits, 1):
            web_sources.append({"title": h["title"], "url": h["url"]})
            excerpt = ""
            if idx <= 2:
                agent_steps.append(f"ページ確認: {h['title'][:30]}")
                excerpt = await fetch_page_excerpt(h["url"], max_chars=1100)
            web_context_lines.append(
                f"[{idx}] {h['title']} ({h['url']})\n"
                f"概要: {h['snippet']}\n"
                + (f"本文抜粋: {excerpt}\n" if excerpt else "")
            )

        if web_context_lines:
            web_block = "<web_search_results>\n" + "\n".join(web_context_lines) + "\n</web_search_results>\n"
        else:
            web_block = "<web_search_results>\n該当する検索結果を取得できませんでした。\n</web_search_results>\n"

        followup_web = (
            f"現在日時: {now_str}\n"
            f"{past_context}"
            f"{web_block}"
            f"<current_question>\n{question_text or '（画像の内容について教えてください）'}{image_note}\n</current_question>\n"
            "※今回は[[WEB_SEARCH:...]]タグは出力せず、上記の検索結果を根拠にしてわかりやすく正確に回答してください。"
        )
        if has_image:
            followup_web_content: Any = [
                {"type": "text", "text": followup_web},
                {"type": "image_url", "image_url": {"url": req.image_data}},
            ]
        else:
            followup_web_content = followup_web
        messages[-1] = {"role": "user", "content": followup_web_content}
        raw_answer = await call_gemma_chat(messages, max_tokens=2048)

    # 特殊タグ [[TIME_RAG: start=..., end=..., topic=...]] を検出したら期間内のもっとも最近の似た記憶を追加取得して再生成
    time_match = re.search(
        r"\[\[TIME_RAG:\s*start=([^,\]]+),\s*end=([^,\]]+),\s*topic=([^\]]+)\]\]",
        raw_answer,
    )
    if time_match:
        t_start = time_match.group(1).strip()
        t_end = time_match.group(2).strip()
        t_topic = time_match.group(3).strip()
        topic_emb = await get_embedding(t_topic, is_query=True)
        time_hit = db.search_recent_in_range(topic_emb, t_start, t_end, user_name=user_name)

        if time_hit:
            if all(m.get("question_text") != time_hit.get("question_text") for m in similar):
                similar.append(time_hit)
            time_block = (
                "<time_rag_memory>\n"
                + format_memory_items([time_hit])
                + f"\n（期間 {t_start} 〜 {t_end} の中でもっとも最近の関連記録）\n"
                "</time_rag_memory>\n"
            )
        else:
            time_block = (
                f"<time_rag_memory>\n期間 {t_start} 〜 {t_end}（キーワード: {t_topic}）には該当する記録が見つかりませんでした。\n</time_rag_memory>\n"
            )

        followup_text = (
            f"現在日時: {now_str}\n"
            f"{past_context}"
            f"{time_block}"
            f"<current_question>\n{question_text or '（画像の内容について教えてください）'}\n</current_question>\n"
            "※今回は[[TIME_RAG:...]]タグは出力せず、上記の記憶を踏まえて直接回答してください。"
        )
        if has_image:
            followup_content: Any = [
                {"type": "text", "text": followup_text},
                {"type": "image_url", "image_url": {"url": req.image_data}},
            ]
        else:
            followup_content = followup_text

        messages[-1] = {"role": "user", "content": followup_content}
        raw_answer = await call_gemma_chat(messages, max_tokens=2048)

    # 特殊タグ [[START_QUIZ: topic=..., count=...]] を検出したらテスト画面起動トリガーを返す
    quiz_match = re.search(
        r"\[\[START_QUIZ:\s*topic=([^,\]]+)(?:,\s*count=(\d+))?\s*\]\]",
        raw_answer,
    )
    if quiz_match:
        q_topic = quiz_match.group(1).strip()
        q_count = int(quiz_match.group(2)) if quiz_match.group(2) else 3
        q_count = max(1, min(10, q_count))
        return {
            "effective_question": search_text,
            "similar_mistakes": similar,
            "explanation": f"「**{q_topic}**」の苦手克服Webテスト（{q_count}問）を作成します。テスト画面へ移動します。",
            "suggested_tag": q_topic,
            "suggested_point": f"{q_topic}の苦手克服テストを実施",
            "rag_id": None,
            "quiz_trigger": {"topic": q_topic, "count": q_count},
        }

    explanation, suggested_tag, suggested_point, should_save_rag = extract_meta(raw_answer, search_text)

    rag_id: int | None = None
    if should_save_rag:
        # 質問と回答を日時付きセットでベクトル化してRAGメモリへ自動保存
        rag_doc = f"日時: {now_str}\n質問: {search_text}\n要点: {suggested_point}\n回答: {explanation}"[:6000]
        rag_embedding = await get_embedding(
            rag_doc,
            is_query=False,
            title=suggested_tag or "none",
        )
        rag_id = db.add_rag_memory(
            question_text=search_text,
            explanation=explanation,
            subject_tag=suggested_tag,
            key_point=suggested_point,
            embedding=rag_embedding,
            user_name=user_name,
        )

    return {
        "effective_question": search_text,
        "similar_mistakes": similar,
        "explanation": explanation,
        "suggested_tag": suggested_tag,
        "suggested_point": suggested_point,
        "rag_id": rag_id,
        "rag_skipped": not should_save_rag,
        "agent_steps": agent_steps,
        "web_sources": web_sources,
    }


@app.post("/api/ask_stream")
async def ask_question_stream(req: AskRequest, user_name: str = Depends(get_request_user)) -> StreamingResponse:
    """通常チャットをSSEトークンストリーミングで返す（Web検索・期間RAG・テスト起動対応）。"""
    question_text = req.question.strip()
    has_image = bool(req.image_data.strip())
    if not question_text and not has_image:
        raise HTTPException(status_code=400, detail="問題文または画像を入力してください。")

    async def event_gen():
        try:
            # Cloudflare等のプロキシバッファリングを即座に解除するための初期コメント
            yield ": stream-open\n\n"
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
            search_text = question_text
            if not search_text and has_image:
                yield f"data: {json.dumps({'type': 'status', 'text': '画像の問題文を読み取っています…'}, ensure_ascii=False)}\n\n"
                search_text = await transcribe_image_question(req.image_data)

            query_embedding = await get_embedding(search_text, is_query=True)
            min_score = req.threshold if req.threshold is not None else SIMILARITY_THRESHOLD
            similar = db.search_similar_memories(
                query_embedding,
                top_k=3,
                min_score=min_score,
                user_name=user_name,
            )

            past_context = ""
            if similar:
                past_context = (
                    "<past_memory>\n"
                    + format_memory_items(similar)
                    + "\n</past_memory>\n"
                    "※<past_memory>に過去のつまずきや会話がある場合、関連するものだけ簡潔に1〜2文で触れてから、"
                    "<current_question>の解説を行ってください。\n\n"
                )

            system_prompt = (
                f"あなたは生徒の質問に丁寧に答える学習パートナーAI「学萌（がくもん）」です。現在日時は {now_str} です。\n"
                "回答はわかりやすい日本語で、必要に応じて数式（KaTeX対応の $...$ や $$...$$）と手順を整理して書いてください。\n"
                "直前の会話履歴がある場合は文脈を踏まえて自然に答えてください。\n"
                "もし<past_memory>に関連する過去の記録があれば、「以前も〜でつまずいていたね」のように自然に振り返りを入れてください。\n"
                "ただし、<past_memory>の内容と今回の質問が無関係な場合は無理に言及しないでください。\n\n"
                "【期間指定の過去振り返りタグ】\n"
                "ユーザーが「昨日」「先週」「今月」「〇〇月〇〇日」など過去の時期を指定して自分の記憶・勉強内容を振り返りたい質問をしたときは、"
                "他の文章を一切書かずに次の特殊タグだけを1行出力してください：\n"
                "[[TIME_RAG: start=YYYY-MM-DD, end=YYYY-MM-DD, topic=分野やキーワード]]\n\n"
                "【苦手克服Webテスト起動タグ】\n"
                "ユーザーが「テストを作って」「小テストを出して」「Webテストを開いて」「問題を解きたい」などと頼んだときは、"
                "他の文章を一切書かずに次の特殊タグだけを1行出力してください（問題数指定がなければ count=3）：\n"
                "[[START_QUIZ: topic=分野やテーマ, count=3]]\n\n"
                "【Web検索エージェントの特殊タグ】\n"
                "最新の出来事・統計データ・正確な年号・人物・法律・制度など、Webで最新の事実を確認した方が正確に答えられる質問のときは、"
                "他の文章を一切書かずに次の特殊タグだけを1行出力してください：\n"
                "[[WEB_SEARCH: query=検索キーワード]]\n"
                "※計算問題や一般的な基礎概念・雑談など検索が不要な場合はタグを出さずそのまま答えてください。\n\n"
                "通常の回答をするときは、回答の最後に必ず次の2行だけを追加してください（本文とは別の行に書くこと）：\n"
                "【単元】話題の分野や単元名（雑談・挨拶の場合は「雑談・挨拶」など）\n"
                "【つまずき要点】このやりとりの要点や覚えておきたいポイントを1文で短く（ただし、挨拶・感謝・相槌など記憶に残す必要がないやりとりの場合は必ず [[NO_RAG]] とだけ書くこと）"
            )

            image_note = (
                "\n※画像が添付されています。まず図に書かれた頂点名・各辺の長さ・条件の対応を1つずつ正確に確認してから解答してください。"
                if has_image
                else ""
            )
            user_text = (
                f"現在日時: {now_str}\n"
                f"{past_context}"
                f"<current_question>\n{question_text or '（画像の内容について教えてください）'}{image_note}\n</current_question>"
            )
            user_content: Any = (
                [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": req.image_data}},
                ]
                if has_image
                else user_text
            )

            messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
            for h in req.history[-6:]:
                role = h.get("role")
                content = (h.get("content") or "").strip()
                if role in ("user", "assistant") and content:
                    messages.append({"role": role, "content": content[:1500]})
            messages.append({"role": "user", "content": user_content})

            async def run_chat_stream_pass(pass_messages: list[dict[str, Any]], allow_special: bool):
                raw_acc = ""
                hold_buf = ""
                suppress_meta = False

                async with httpx.AsyncClient(timeout=180.0) as client:
                    async with client.stream(
                        "POST",
                        f"{LLM_BASE_URL}/chat/completions",
                        json={
                            "model": LLM_MODEL,
                            "messages": pass_messages,
                            "max_tokens": 2048,
                            "temperature": 0.3,
                            "stream": True,
                            "reasoning_effort": "high",
                            "reasoning_budget_tokens": 600,
                        },
                    ) as resp:
                        resp.raise_for_status()
                        async for line in resp.aiter_lines():
                            if not line.startswith("data:"):
                                continue
                            payload = line[5:].strip()
                            if payload == "[DONE]":
                                break
                            try:
                                chunk = json.loads(payload)
                                delta = chunk["choices"][0].get("delta", {})
                                tok = delta.get("content") or ""
                            except Exception:
                                continue
                            if not tok:
                                continue
                            raw_acc += tok
                            if suppress_meta:
                                continue

                            hold_buf += tok

                            # 特殊タグ（[[WEB_SEARCH / [[TIME_RAG / [[START_QUIZ）検出時は即中断して制御パスへ
                            if allow_special and re.search(
                                r"\[\[(?:WEB_SEARCH|TIME_RAG|START_QUIZ):[^\]]+\]\]",
                                raw_acc,
                            ):
                                yield ("result", (raw_acc, True))
                                return

                            # 末尾の【単元】/【つまずき要点】が始まったら表示を止める
                            meta_pos = re.search(r"(?:^|\n)\s*【(?:単元|つまずき要点)】", hold_buf)
                            if meta_pos:
                                before = hold_buf[:meta_pos.start()]
                                if before:
                                    yield ("event", f"data: {json.dumps({'type': 'token', 'text': before}, ensure_ascii=False)}\n\n")
                                hold_buf = ""
                                suppress_meta = True
                                continue

                            # タグ開始の可能性（"[[" や "【単" 等）がある末尾だけ短く保留
                            if (
                                (allow_special and hold_buf.lstrip().startswith("[") and len(hold_buf) < 90 and "]]" not in hold_buf)
                                or hold_buf.endswith(("【", "【単", "【単元", "【つ", "【つま", "【つまず", "【つまずき", "【つまずき要", "【つまずき要点", "["))
                            ):
                                continue

                            yield ("event", f"data: {json.dumps({'type': 'token', 'text': hold_buf}, ensure_ascii=False)}\n\n")
                            hold_buf = ""

                if hold_buf and not suppress_meta:
                    clean_tail = re.split(r"(?:^|\n)\s*【(?:単元|つまずき要点)】", hold_buf, maxsplit=1)[0]
                    if clean_tail and not (allow_special and re.search(r"\[\[(?:WEB_SEARCH|TIME_RAG|START_QUIZ):", clean_tail)):
                        yield ("event", f"data: {json.dumps({'type': 'token', 'text': clean_tail}, ensure_ascii=False)}\n\n")

                yield ("result", (raw_acc, False))

            raw_answer = ""
            agent_steps: list[str] = []
            web_sources: list[dict[str, str]] = []

            async for kind, val in run_chat_stream_pass(messages, allow_special=True):
                if kind == "event":
                    yield val
                else:
                    raw_answer, _ = val

            # [[WEB_SEARCH: query=...]]
            web_match = re.search(r"\[\[WEB_SEARCH:\s*query=([^\]]+)\]\]", raw_answer)
            if web_match:
                search_q = web_match.group(1).strip()
                agent_steps.append(f"Web検索: {search_q}")
                yield f"data: {json.dumps({'type': 'reset'}, ensure_ascii=False)}\n\n"
                yield f"data: {json.dumps({'type': 'status', 'text': f'Web検索中: {search_q}'}, ensure_ascii=False)}\n\n"

                hits = await run_web_search(search_q)
                web_context_lines: list[str] = []
                for idx, h in enumerate(hits, 1):
                    web_sources.append({"title": h["title"], "url": h["url"]})
                    excerpt = ""
                    if idx <= 2:
                        agent_steps.append(f"ページ確認: {h['title'][:30]}")
                        excerpt = await fetch_page_excerpt(h["url"], max_chars=1100)
                    web_context_lines.append(
                        f"[{idx}] {h['title']} ({h['url']})\n"
                        f"概要: {h['snippet']}\n"
                        + (f"本文抜粋: {excerpt}\n" if excerpt else "")
                    )

                web_block = (
                    "<web_search_results>\n" + "\n".join(web_context_lines) + "\n</web_search_results>\n"
                    if web_context_lines
                    else "<web_search_results>\n該当する検索結果を取得できませんでした。\n</web_search_results>\n"
                )
                followup_web = (
                    f"現在日時: {now_str}\n"
                    f"{past_context}"
                    f"{web_block}"
                    f"<current_question>\n{question_text or '（画像の内容について教えてください）'}{image_note}\n</current_question>\n"
                    "※今回は[[WEB_SEARCH:...]]タグは出力せず、上記の検索結果を根拠にしてわかりやすく正確に回答してください。"
                )
                messages[-1] = {
                    "role": "user",
                    "content": (
                        [{"type": "text", "text": followup_web}, {"type": "image_url", "image_url": {"url": req.image_data}}]
                        if has_image
                        else followup_web
                    ),
                }
                raw_answer = ""
                async for kind, val in run_chat_stream_pass(messages, allow_special=False):
                    if kind == "event":
                        yield val
                    else:
                        raw_answer, _ = val

            # [[TIME_RAG: start=..., end=..., topic=...]]
            time_match = re.search(
                r"\[\[TIME_RAG:\s*start=([^,\]]+),\s*end=([^,\]]+),\s*topic=([^\]]+)\]\]",
                raw_answer,
            )
            if time_match:
                t_start = time_match.group(1).strip()
                t_end = time_match.group(2).strip()
                t_topic = time_match.group(3).strip()
                yield f"data: {json.dumps({'type': 'reset'}, ensure_ascii=False)}\n\n"
                yield f"data: {json.dumps({'type': 'status', 'text': f'過去の記憶を検索中（{t_start}〜{t_end}）…'}, ensure_ascii=False)}\n\n"

                topic_emb = await get_embedding(t_topic, is_query=True)
                time_hit = db.search_recent_in_range(topic_emb, t_start, t_end, user_name=user_name)
                if time_hit:
                    if all(m.get("question_text") != time_hit.get("question_text") for m in similar):
                        similar.append(time_hit)
                    time_block = (
                        "<time_rag_memory>\n"
                        + format_memory_items([time_hit])
                        + f"\n（期間 {t_start} 〜 {t_end} の中でもっとも最近の関連記録）\n"
                        "</time_rag_memory>\n"
                    )
                else:
                    time_block = (
                        f"<time_rag_memory>\n期間 {t_start} 〜 {t_end}（キーワード: {t_topic}）には該当する記録が見つかりませんでした。\n</time_rag_memory>\n"
                    )
                followup_text = (
                    f"現在日時: {now_str}\n"
                    f"{past_context}"
                    f"{time_block}"
                    f"<current_question>\n{question_text or '（画像の内容について教えてください）'}\n</current_question>\n"
                    "※今回は[[TIME_RAG:...]]タグは出力せず、上記の記憶を踏まえて直接回答してください。"
                )
                messages[-1] = {
                    "role": "user",
                    "content": (
                        [{"type": "text", "text": followup_text}, {"type": "image_url", "image_url": {"url": req.image_data}}]
                        if has_image
                        else followup_text
                    ),
                }
                raw_answer = ""
                async for kind, val in run_chat_stream_pass(messages, allow_special=False):
                    if kind == "event":
                        yield val
                    else:
                        raw_answer, _ = val

            # [[START_QUIZ: topic=..., count=...]]
            quiz_match = re.search(
                r"\[\[START_QUIZ:\s*topic=([^,\]]+)(?:,\s*count=(\d+))?\s*\]\]",
                raw_answer,
            )
            if quiz_match:
                q_topic = quiz_match.group(1).strip()
                q_count = max(1, min(10, int(quiz_match.group(2)) if quiz_match.group(2) else 3))
                done_payload = {
                    "type": "done",
                    "effective_question": search_text,
                    "similar_mistakes": similar,
                    "explanation": f"「**{q_topic}**」の苦手克服Webテスト（{q_count}問）を作成します。テスト画面へ移動します。",
                    "suggested_tag": q_topic,
                    "suggested_point": f"{q_topic}の苦手克服テストを実施",
                    "rag_id": None,
                    "rag_skipped": True,
                    "agent_steps": agent_steps,
                    "web_sources": web_sources,
                    "quiz_trigger": {"topic": q_topic, "count": q_count},
                }
                yield f"data: {json.dumps(done_payload, ensure_ascii=False)}\n\n"
                return

            explanation, suggested_tag, suggested_point, should_save_rag = extract_meta(raw_answer, search_text)
            rag_id: int | None = None
            if should_save_rag:
                rag_doc = f"日時: {now_str}\n質問: {search_text}\n要点: {suggested_point}\n回答: {explanation}"[:6000]
                rag_embedding = await get_embedding(
                    rag_doc,
                    is_query=False,
                    title=suggested_tag or "none",
                )
                rag_id = db.add_rag_memory(
                    question_text=search_text,
                    explanation=explanation,
                    subject_tag=suggested_tag,
                    key_point=suggested_point,
                    embedding=rag_embedding,
                    user_name=user_name,
                )

            done_payload = {
                "type": "done",
                "effective_question": search_text,
                "similar_mistakes": similar,
                "explanation": explanation,
                "suggested_tag": suggested_tag,
                "suggested_point": suggested_point,
                "rag_id": rag_id,
                "rag_skipped": not should_save_rag,
                "agent_steps": agent_steps,
                "web_sources": web_sources,
            }
            yield f"data: {json.dumps(done_payload, ensure_ascii=False)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@app.get("/api/mistakes")
async def get_mistakes(user_name: str = Depends(get_request_user)) -> dict[str, Any]:
    return {"items": db.list_mistakes(user_name=user_name)}


@app.post("/api/mistakes")
async def create_mistake(req: MistakeCreateRequest, user_name: str = Depends(get_request_user)) -> dict[str, Any]:
    q_text = req.question_text.strip()
    m_point = req.mistake_point.strip()
    if not q_text or not m_point:
        raise HTTPException(status_code=400, detail="問題文とつまずき要点の両方が必要です。")

    doc_text = f"{q_text}\nつまずき要点: {m_point}"
    embedding = await get_embedding(doc_text, is_query=False, title=req.subject_tag or "none")
    new_id = db.add_mistake(
        question_text=q_text,
        mistake_point=m_point,
        subject_tag=req.subject_tag.strip(),
        explanation=req.explanation.strip(),
        image_data=req.image_data.strip(),
        embedding=embedding,
        user_name=user_name,
    )
    return {"id": new_id, "status": "saved"}


@app.delete("/api/mistakes/{mistake_id}")
async def remove_mistake(mistake_id: int, user_name: str = Depends(get_request_user)) -> dict[str, Any]:
    deleted = db.delete_mistake(mistake_id, user_name=user_name)
    if not deleted:
        raise HTTPException(status_code=404, detail="指定された記録が見つかりません。")
    return {"status": "deleted"}


@app.get("/api/rag")
async def get_rag_memories(user_name: str = Depends(get_request_user)) -> dict[str, Any]:
    return {"items": db.list_rag_memories(user_name=user_name)}


@app.get("/api/rag/map")
async def get_rag_map(user_name: str = Depends(get_request_user)) -> dict[str, Any]:
    return db.get_rag_map(user_name=user_name)


@app.delete("/api/rag/{memory_id}")
async def remove_rag_memory(memory_id: int, user_name: str = Depends(get_request_user)) -> dict[str, Any]:
    deleted = db.delete_rag_memory(memory_id, user_name=user_name)
    if not deleted:
        raise HTTPException(status_code=404, detail="指定されたRAG記憶が見つかりません。")
    return {"status": "deleted"}


def sanitize_latex_json(text: str) -> str:
    """JSON文字列内の未エスケープなLaTeXコマンド（\\frac, \\sqrt, \\times等）を安全に二重エスケープする。"""
    # すでに \\ になっている箇所はそのまま残し、単独の \ + 2文字以上の英字（\uXXXX除く）を \\ に直す
    def repl_cmd(m: re.Match[str]) -> str:
        cmd = m.group(1)
        if re.fullmatch(r"u[0-9a-fA-F]{4}", cmd):
            return "\\" + cmd
        return "\\\\" + cmd

    s = re.sub(r"(?<!\\)\\([a-zA-Z]{2,})", repl_cmd, text)
    # その他、JSONで不正な単独バックスラッシュもエスケープ
    s = re.sub(r'(?<!\\)\\(?!["\\/bfnrtu])', r"\\\\", s)
    return s


def parse_quiz_json(raw: str) -> list[dict[str, Any]]:
    cleaned = raw.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", cleaned)
    if fence:
        cleaned = fence.group(1).strip()

    # JSONオブジェクトまたは配列部分を抽出
    obj_match = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", cleaned)
    if obj_match:
        cleaned = obj_match.group(1)

    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        data = json.loads(sanitize_latex_json(cleaned))

    items = data.get("questions", []) if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise ValueError("questions is not a list")

    validated: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        q = str(item.get("question") or "").strip()
        if not q:
            continue

        correct_ans = str(item.get("correct_answer") or "").strip()
        wrong_raw = item.get("wrong_choices")

        if correct_ans and isinstance(wrong_raw, list) and len(wrong_raw) >= 1:
            # 重複や正解と同一の誤答を除外して4択を組み立て、Python側でシャッフル＆正解位置確定
            wrongs: list[str] = []
            seen = {correct_ans}
            for w in wrong_raw:
                ws = str(w).strip()
                if ws and ws not in seen:
                    seen.add(ws)
                    wrongs.append(ws)
                if len(wrongs) >= 3:
                    break
            if not wrongs:
                continue
            choices = [correct_ans] + wrongs
            random.shuffle(choices)
            ans = choices.index(correct_ans)
        else:
            choices = item.get("choices") or []
            if not isinstance(choices, list) or len(choices) < 2:
                continue
            choices = [str(c).strip() for c in choices[:4]]
            ans = int(item.get("answer_index", 0))
            if ans < 0 or ans >= len(choices):
                ans = 0

        validated.append({
            "question": q,
            "choices": choices,
            "answer_index": ans,
            "explanation": str(item.get("explanation") or "").strip(),
            "source_hint": str(item.get("source_hint") or "").strip(),
        })
    return validated


@app.post("/api/quiz/generate")
async def generate_quiz(req: QuizGenerateRequest, user_name: str = Depends(get_request_user)) -> dict[str, Any]:
    topic = req.topic.strip()
    if not topic:
        raise HTTPException(status_code=400, detail="テストのテーマを入力してください。")
    count = max(1, min(10, req.count))

    topic_emb = await get_embedding(topic, is_query=True)
    related = db.search_similar_memories(topic_emb, top_k=5, min_score=0.45, user_name=user_name)

    if related:
        memory_block = (
            "【ユーザーの過去のつまずき・学習履歴（優先してここから類題を作ること）】\n"
            + format_memory_items(related)
        )
    else:
        memory_block = "【ユーザーの過去のつまずき履歴】該当記録はまだないため、指定テーマの典型的なつまずきやすい問題を作成してください。"

    system_prompt = (
        "あなたはWebテスト（CBT試験）の作成者です。"
        "必ず有効なJSONのみを出力してください。余計な挨拶や説明文は一切書かないでください。\n"
        "出力スキーマ（必ずこのキー順で書くこと）：\n"
        '{"questions": [{"question": "問題文", "explanation": "先に手順通りに解いて正解を導く解説", '
        '"correct_answer": "explanationで求めた正解そのまま", '
        '"wrong_choices": ["明確に異なる誤答1", "明確に異なる誤答2", "明確に異なる誤答3"], '
        '"source_hint": "どの苦手・単元に基づくか短いメモ"}]}\n'
        "※まず explanation で正確に計算・確認してから、その結果と完全に一致する correct_answer を書いてください。\n"
        "※wrong_choices の3つはすべて互いに異なる内容にし、correct_answer と重複させないでください。\n"
        "※数式は必ず $...$ で両側を囲み、JSON内のバックスラッシュ（\\\\frac 等）は二重にエスケープしてください。"
    )

    user_prompt = (
        f"テーマ: {topic}\n"
        f"問題数: {count}問（4択問題）\n\n"
        f"{memory_block}\n\n"
        f"上記を踏まえ、苦手克服に役立つ4択問題をちょうど{count}問、JSONのみで出力してください。"
    )

    raw = await call_gemma_chat(
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        max_tokens=2400,
    )

    try:
        questions = parse_quiz_json(raw)
    except Exception:
        # 1回だけJSON修復リトライ
        repair_raw = await call_gemma_chat(
            [
                {"role": "system", "content": "次のテキストを厳密に有効なJSONオブジェクト（{\"questions\": [...]}）だけに修正して出力してください。"},
                {"role": "user", "content": raw},
            ],
            max_tokens=2400,
        )
        try:
            questions = parse_quiz_json(repair_raw)
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"テスト問題のJSON生成に失敗しました。もう一度お試しください。（{exc}）",
            ) from exc

    if not questions:
        raise HTTPException(status_code=500, detail="問題が生成されませんでした。テーマを変えてお試しください。")

    result = {
        "topic": topic,
        "based_on_count": len(related),
        "questions": questions,
    }
    try:
        log_dir = BASE_DIR / "logs"
        log_dir.mkdir(exist_ok=True)
        (log_dir / "last_quiz.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass
    return result


VOICE_TAG_RE = re.compile(
    r"\[\[(?:NO_RAG|USER_SAID:[^\]]+|WEB_SEARCH:[^\]]+|START_QUIZ(?::[^\]]*)?|OPEN_BOOK(?::[^\]]*)?)\]\]"
)


def parse_voice_triggers(full_text: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    quiz_trigger: dict[str, Any] | None = None
    book_trigger: dict[str, Any] | None = None

    qm = re.search(r"\[\[START_QUIZ(?::\s*topic=([^,\]]*)(?:,\s*count=(\d+))?)?\s*\]\]", full_text)
    if qm:
        topic = (qm.group(1) or "").strip() or "これまでの苦手単元"
        try:
            count = max(1, min(10, int(qm.group(2)))) if qm.group(2) else 3
        except ValueError:
            count = 3
        quiz_trigger = {"topic": topic, "count": count}

    bm = re.search(r"\[\[OPEN_BOOK(?::\s*topic=([^\]]*))?\s*\]\]", full_text)
    if bm:
        book_trigger = {"topic": (bm.group(1) or "").strip()}

    return quiz_trigger, book_trigger


@app.post("/api/voice/ask_stream")
async def voice_ask_stream(req: VoiceAskRequest, user_name: str = Depends(get_request_user)) -> StreamingResponse:
    question_text = req.question.strip()
    if not question_text:
        raise HTTPException(status_code=400, detail="発話テキストが空です。")

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    query_embedding = await get_embedding(question_text, is_query=True)
    min_score = req.threshold if req.threshold is not None else SIMILARITY_THRESHOLD
    similar = db.search_similar_memories(query_embedding, top_k=3, min_score=min_score, user_name=user_name)

    past_context = ""
    if similar:
        past_context = (
            "<past_memory>\n"
            + format_memory_items(similar)
            + "\n</past_memory>\n"
            "※関係がある過去記録だけ自然な口調で触れてください。\n\n"
        )

    persona = "あなたは親しみやすくわかりやすい学習パートナーAI「学萌（がくもん）」です。"

    system_prompt = (
        f"{persona}現在日時は {now_str} です。\n"
        "これはリアルタイム音声会話モードです。以下のルールを必ず守ってください：\n"
        "1. 話し言葉で簡潔に答える（1回の返答は2〜4文程度、長くしゃべりすぎない）。\n"
        "2. マークダウン記号（#、*、-、```）や数式記号（$、\\frac）は使わず、声で聞いてそのままわかる日本語だけで話す。\n"
        "3. 句読点（。、！？）をこまめに入れて話しやすくする。\n"
        "4. 【単元】などのメタ行は出力しない。\n"
        "5. 挨拶・感謝・相槌など記憶に残す必要がないやりとりの場合だけ、返答の最後に [[NO_RAG]] とだけ付けてください。\n"
        "6. 最新の出来事・統計・正確な日付・ニュースなどWebで調べた方が正確な質問のときだけ、他の言葉を一切書かずに [[WEB_SEARCH: query=検索キーワード]] とだけ出力してください。\n"
        "7. ユーザーが「Webテストを開いて」「テストを作って」「問題を解きたい」などと頼んだら、短い一言返答の最後に [[START_QUIZ: topic=単元やテーマ, count=3]] を付けてください（問題数指定があればその数字）。\n"
        "8. ユーザーが「本を開いて」「AI本を見せて」「本棚を開いて」「〜の本（教科書）を作って」などと頼んだら、短い一言返答の最後に [[OPEN_BOOK: topic=テーマ]] を付けてください（単に本棚を開くだけなら topic= は空で [[OPEN_BOOK]]）。"
    )

    messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for h in req.history[-6:]:
        role = h.get("role")
        content = (h.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content[:800]})
    messages.append({
        "role": "user",
        "content": f"現在日時: {now_str}\n{past_context}<current_question>\n{question_text}\n</current_question>",
    })

    async def event_gen():
        async def run_stream_pass(pass_messages: list[dict[str, Any]], allow_web_tag: bool):
            pass_full = ""
            buf = ""
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream(
                    "POST",
                    f"{LLM_BASE_URL}/chat/completions",
                    json={
                        "model": LLM_MODEL,
                        "messages": pass_messages,
                        "max_tokens": 900,
                        "temperature": 0.5,
                        "stream": True,
                        "reasoning_effort": "medium",
                        "reasoning_budget_tokens": 250,
                    },
                ) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            break
                        try:
                            chunk = json.loads(payload)
                            delta = chunk["choices"][0].get("delta", {})
                            tok = delta.get("content") or ""
                        except Exception:
                            continue
                        if not tok:
                            continue
                        pass_full += tok
                        buf += tok

                        # [[NO_RAG]] や [[WEB_SEARCH:...]] 等のタグが途中の場合は確定するまでバッファに留める
                        if "[" in buf and not VOICE_TAG_RE.search(buf):
                            continue

                        if allow_web_tag and re.search(r"\[\[WEB_SEARCH:\s*query=([^\]]+)\]\]", pass_full):
                            # Web検索タグを検出したらこのパスを中断して検索フェーズへ
                            yield ("result", (pass_full, "", True))
                            return

                        clean_buf = VOICE_TAG_RE.sub("", buf)
                        if clean_buf != buf:
                            buf = clean_buf

                        if "[" not in tok and "]" not in tok:
                            yield ("event", f"data: {json.dumps({'type': 'token', 'text': tok}, ensure_ascii=False)}\n\n")

                        while True:
                            m = re.search(r"[。！？\n]", buf)
                            if not m and len(buf) >= 18:
                                m = re.search(r"[、]", buf)
                            if not m:
                                break
                            cut = m.end()
                            phrase = VOICE_TAG_RE.sub("", buf[:cut]).strip()
                            buf = buf[cut:]
                            if phrase:
                                yield ("event", f"data: {json.dumps({'type': 'sentence', 'text': phrase}, ensure_ascii=False)}\n\n")

            yield ("result", (pass_full, buf, False))

        try:
            full_text = ""
            tail_buf = ""
            need_web = False

            async for kind, val in run_stream_pass(messages, allow_web_tag=True):
                if kind == "event":
                    yield val
                else:
                    full_text, tail_buf, need_web = val

            # [[WEB_SEARCH: ...]] が出た場合は検索して2パス目で回答をストリーミング
            web_match = re.search(r"\[\[WEB_SEARCH:\s*query=([^\]]+)\]\]", full_text) if (need_web or "[[WEB_SEARCH:" in full_text) else None
            if web_match:
                search_q = web_match.group(1).strip()
                yield f"data: {json.dumps({'type': 'status', 'text': f'Web検索中: {search_q}'}, ensure_ascii=False)}\n\n"
                hits = await run_web_search(search_q)
                web_lines: list[str] = []
                for idx, h in enumerate(hits[:3], 1):
                    excerpt = await fetch_page_excerpt(h["url"], max_chars=700) if idx == 1 else ""
                    web_lines.append(
                        f"[{idx}] {h['title']}\n概要: {h['snippet']}"
                        + (f"\n本文: {excerpt}" if excerpt else "")
                    )
                web_block = (
                    "<web_search_results>\n" + "\n".join(web_lines) + "\n</web_search_results>\n"
                    if web_lines
                    else "<web_search_results>\n検索結果を取得できませんでした。\n</web_search_results>\n"
                )
                pass2_messages = list(messages)
                pass2_messages[-1] = {
                    "role": "user",
                    "content": (
                        f"現在日時: {now_str}\n{past_context}{web_block}"
                        f"<current_question>\n{question_text}\n</current_question>\n"
                        "※今回は[[WEB_SEARCH:...]]を出さず、検索結果を踏まえて話し言葉で簡潔に答えてください。"
                    ),
                }
                full_text = ""
                tail_buf = ""
                async for kind, val in run_stream_pass(pass2_messages, allow_web_tag=False):
                    if kind == "event":
                        yield val
                    else:
                        full_text, tail_buf, _ = val

            quiz_trigger, book_trigger = parse_voice_triggers(full_text)
            skip_voice_rag = bool(re.search(r"\[\[NO_RAG\]\]", full_text)) or bool(quiz_trigger or book_trigger)
            spoken_full = VOICE_TAG_RE.sub("", full_text).strip()
            tail_phrase = VOICE_TAG_RE.sub("", tail_buf).strip()
            if tail_phrase:
                yield f"data: {json.dumps({'type': 'sentence', 'text': tail_phrase}, ensure_ascii=False)}\n\n"

            # 挨拶・感謝（[[NO_RAG]]）や画面遷移指示以外だけRAGへ自動保存
            if spoken_full and not skip_voice_rag:
                try:
                    rag_doc = f"日時: {now_str}\n質問: {question_text}\n回答: {spoken_full}"[:6000]
                    rag_emb = await get_embedding(rag_doc, is_query=False, title="音声会話")
                    db.add_rag_memory(
                        question_text=question_text,
                        explanation=spoken_full,
                        subject_tag="音声会話",
                        key_point=spoken_full[:90],
                        embedding=rag_emb,
                        user_name=user_name,
                    )
                except Exception:
                    pass

            yield f"data: {json.dumps({'type': 'done', 'full_text': spoken_full, 'rag_skipped': skip_voice_rag, 'quiz_trigger': quiz_trigger, 'book_trigger': book_trigger}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@app.post("/api/voice/ask_audio_stream")
async def voice_ask_audio_stream(req: VoiceAudioAskRequest, user_name: str = Depends(get_request_user)) -> StreamingResponse:
    """録音したWAV音声を直接 Gemma 4 12B Unified (input_audio) に渡して文節ストリーミング応答する。"""
    if not req.audio_b64.strip():
        raise HTTPException(status_code=400, detail="音声データが空です。")

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    persona = "あなたは親しみやすくわかりやすい学習パートナーAI「学萌（がくもん）」です。"

    system_prompt = (
        f"{persona}現在日時は {now_str} です。\n"
        "ユーザーから直接、日本語の音声（WAV）が届きます。\n"
        "【最重要】ユーザーの音声は日本語（日本の学生の発話）です。英語や他言語に誤認識せず、必ず日本語として正確に聞き取ってください。\n"
        "ルール：\n"
        "1. 話し言葉で簡潔に答える（1回の返答は2〜4文程度）。\n"
        "2. マークダウン記号や数式記号は使わず、声で聞いてそのままわかる日本語だけで話す。\n"
        "3. 句読点（。、！？）をこまめに入れて話しやすくする。\n"
        "4. 最新の出来事・統計・日付などWebで調べた方が正確なときだけ、他の言葉を書かずに [[WEB_SEARCH: query=検索キーワード]] とだけ出力する。\n"
        "5. 返答の最後に必ず、ユーザーの音声から聞き取った日本語の発話をそのまま [[USER_SAID: 聞き取った日本語]] の形で1行追加する（英語に翻訳しない・読み上げには使いません）。\n"
        "6. 挨拶・感謝・雑音のみなど記憶不要な場合だけ、さらに [[NO_RAG]] も付ける。\n"
        "7. ユーザーが「Webテストを開いて」「テストを作って」「問題を解きたい」などと頼んだら、短い一言返答に続けて [[START_QUIZ: topic=単元やテーマ, count=3]] を付ける（問題数指定があればその数字）。\n"
        "8. ユーザーが「本を開いて」「AI本を見せて」「本棚を開いて」「〜の本（教科書）を作って」などと頼んだら、短い一言返答に続けて [[OPEN_BOOK: topic=テーマ]] を付ける（単に本棚を開くだけなら [[OPEN_BOOK]]）。"
    )

    messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for h in req.history[-6:]:
        role = h.get("role")
        content = (h.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content[:800]})

    messages.append({
        "role": "user",
        "content": [
            {"type": "text", "text": f"現在日時: {now_str}\n添付の日本語音声を正確に聞き取って、日本語で答えてください。"},
            {"type": "input_audio", "input_audio": {"data": req.audio_b64, "format": "wav"}},
        ],
    })

    async def event_gen():
        async def run_stream_pass(pass_messages: list[dict[str, Any]], allow_web_tag: bool):
            pass_full = ""
            buf = ""
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream(
                    "POST",
                    f"{LLM_BASE_URL}/chat/completions",
                    json={
                        "model": LLM_MODEL,
                        "messages": pass_messages,
                        "max_tokens": 900,
                        "temperature": 0.3,
                        "stream": True,
                        "reasoning_effort": "medium",
                        "reasoning_budget_tokens": 250,
                    },
                ) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            break
                        try:
                            chunk = json.loads(payload)
                            delta = chunk["choices"][0].get("delta", {})
                            tok = delta.get("content") or ""
                        except Exception:
                            continue
                        if not tok:
                            continue
                        pass_full += tok
                        buf += tok

                        if "[" in buf and not VOICE_TAG_RE.search(buf):
                            continue

                        if allow_web_tag and re.search(r"\[\[WEB_SEARCH:\s*query=([^\]]+)\]\]", pass_full):
                            yield ("result", (pass_full, "", True))
                            return

                        clean_buf = VOICE_TAG_RE.sub("", buf)
                        if clean_buf != buf:
                            buf = clean_buf

                        if "[" not in tok and "]" not in tok:
                            yield ("event", f"data: {json.dumps({'type': 'token', 'text': tok}, ensure_ascii=False)}\n\n")

                        while True:
                            m = re.search(r"[。！？\n]", buf)
                            if not m and len(buf) >= 18:
                                m = re.search(r"[、]", buf)
                            if not m:
                                break
                            cut = m.end()
                            phrase = VOICE_TAG_RE.sub("", buf[:cut]).strip()
                            buf = buf[cut:]
                            if phrase:
                                yield ("event", f"data: {json.dumps({'type': 'sentence', 'text': phrase}, ensure_ascii=False)}\n\n")

            yield ("result", (pass_full, buf, False))

        try:
            full_text = ""
            tail_buf = ""
            need_web = False

            async for kind, val in run_stream_pass(messages, allow_web_tag=True):
                if kind == "event":
                    yield val
                else:
                    full_text, tail_buf, need_web = val

            web_match = re.search(r"\[\[WEB_SEARCH:\s*query=([^\]]+)\]\]", full_text) if (need_web or "[[WEB_SEARCH:" in full_text) else None
            if web_match:
                search_q = web_match.group(1).strip()
                yield f"data: {json.dumps({'type': 'status', 'text': f'Web検索中: {search_q}'}, ensure_ascii=False)}\n\n"
                hits = await run_web_search(search_q)
                web_lines: list[str] = []
                for idx, h in enumerate(hits[:3], 1):
                    excerpt = await fetch_page_excerpt(h["url"], max_chars=700) if idx == 1 else ""
                    web_lines.append(
                        f"[{idx}] {h['title']}\n概要: {h['snippet']}"
                        + (f"\n本文: {excerpt}" if excerpt else "")
                    )
                web_block = (
                    "<web_search_results>\n" + "\n".join(web_lines) + "\n</web_search_results>\n"
                    if web_lines
                    else "<web_search_results>\n検索結果を取得できませんでした。\n</web_search_results>\n"
                )
                pass2_messages = list(messages)
                pass2_messages[-1] = {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                f"現在日時: {now_str}\n{web_block}"
                                "※今回は[[WEB_SEARCH:...]]を出さず、添付の音声質問に対して検索結果を踏まえて話し言葉で簡潔に答えてください。"
                            ),
                        },
                        {"type": "input_audio", "input_audio": {"data": req.audio_b64, "format": "wav"}},
                    ],
                }
                full_text = ""
                tail_buf = ""
                async for kind, val in run_stream_pass(pass2_messages, allow_web_tag=False):
                    if kind == "event":
                        yield val
                    else:
                        full_text, tail_buf, _ = val

            quiz_trigger, book_trigger = parse_voice_triggers(full_text)
            skip_voice_rag = bool(re.search(r"\[\[NO_RAG\]\]", full_text)) or bool(quiz_trigger or book_trigger)
            heard_match = re.search(r"\[\[USER_SAID:\s*([^\]]+)\]\]", full_text)
            heard_text = heard_match.group(1).strip() if heard_match else ""
            spoken_full = VOICE_TAG_RE.sub("", full_text).strip()
            tail_phrase = VOICE_TAG_RE.sub("", tail_buf).strip()
            if tail_phrase:
                yield f"data: {json.dumps({'type': 'sentence', 'text': tail_phrase}, ensure_ascii=False)}\n\n"

            if spoken_full and not skip_voice_rag:
                try:
                    q_saved = heard_text or f"（音声質問 {now_str}）"
                    rag_doc = f"日時: {now_str}\n質問: {q_saved}\n回答: {spoken_full}"[:6000]
                    rag_emb = await get_embedding(rag_doc, is_query=False, title="音声会話")
                    db.add_rag_memory(
                        question_text=q_saved,
                        explanation=spoken_full,
                        subject_tag="音声会話",
                        key_point=spoken_full[:90],
                        embedding=rag_emb,
                        user_name=user_name,
                    )
                except Exception:
                    pass

            yield f"data: {json.dumps({'type': 'done', 'full_text': spoken_full, 'heard_text': heard_text, 'rag_skipped': skip_voice_rag, 'quiz_trigger': quiz_trigger, 'book_trigger': book_trigger}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@app.post("/api/note/index")
async def index_handwritten_note(req: NoteIndexRequest, user_name: str = Depends(get_request_user)) -> dict[str, Any]:
    if not req.image_data.strip():
        raise HTTPException(status_code=400, detail="ノート画像が空です。")

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    prompt_text = (
        "これは生徒が書いた手書き学習ノートです。以下の観点で内容を正確に文字起こし・整理してください：\n"
        "- 四角囲み・赤下線・赤文字（特に重要なポイント）\n"
        "- 青文字（補足・メモ）\n"
        "- 本文・数式・図の内容\n"
        "最後に【単元】と【つまずき要点】（このページの要点を1文で）を付けてください。"
    )
    raw = await call_gemma_chat(
        [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt_text},
                    {"type": "image_url", "image_url": {"url": req.image_data}},
                ],
            }
        ],
        max_tokens=1500,
    )
    summary, tag, point, _ = extract_meta(raw, f"ノート「{req.title}」P.{req.page}")
    subject = tag or req.title or "AIノート"
    q_label = f"【AIノート】{req.title} (P.{req.page})"
    rag_doc = f"日時: {now_str}\nノート: {q_label}\n要点: {point}\n内容: {summary}"[:6000]
    emb = await get_embedding(rag_doc, is_query=False, title=subject)
    rag_id = db.add_rag_memory(
        question_text=q_label,
        explanation=summary,
        subject_tag=subject,
        key_point=point or summary[:90],
        embedding=emb,
        user_name=user_name,
    )
    return {
        "rag_id": rag_id,
        "subject_tag": subject,
        "summary": summary,
        "key_point": point,
    }


def extract_book_heading(md: str, fallback: str) -> str:
    for line in md.splitlines():
        m = re.match(r"^\s*#+\s+(.+)$", line)
        if m:
            return m.group(1).strip()[:48]
    return fallback[:48]


@app.get("/api/books")
async def list_books(user_name: str = Depends(get_request_user)) -> dict[str, Any]:
    return {"items": db.list_ai_books(user_name=user_name)}


@app.get("/api/books/{book_id}")
async def get_book(book_id: int, user_name: str = Depends(get_request_user)) -> dict[str, Any]:
    book = db.get_ai_book(book_id, user_name=user_name)
    if not book:
        raise HTTPException(status_code=404, detail="指定されたAI本が見つかりません。")
    return book


@app.delete("/api/books/{book_id}")
async def delete_book(book_id: int, user_name: str = Depends(get_request_user)) -> dict[str, Any]:
    if not db.delete_ai_book(book_id, user_name=user_name):
        raise HTTPException(status_code=404, detail="指定されたAI本が見つかりません。")
    return {"status": "deleted"}


def split_markdown_into_pages(md: str, fallback_title: str, max_chars_per_page: int = 380) -> list[tuple[str, str]]:
    """===PAGE=== 区切りを優先しつつ、1ページが縦スクロール不要な分量に収まるよう自動分割する。"""
    raw_chunks = [c.strip() for c in re.split(r"(?:^|\n)\s*===PAGE===\s*(?:\n|$)", md) if c.strip()]
    if not raw_chunks:
        raw_chunks = [md.strip()]

    final_pages: list[tuple[str, str]] = []
    for chunk in raw_chunks:
        if len(chunk) <= max_chars_per_page + 80:
            title = extract_book_heading(chunk, fallback_title)
            final_pages.append((title, chunk))
            continue

        # 長すぎるページは見出し・段落単位で安全に複数ページへ分割
        blocks = [b.strip() for b in re.split(r"\n{2,}", chunk) if b.strip()]
        cur_blocks: list[str] = []
        cur_len = 0
        base_title = extract_book_heading(chunk, fallback_title)

        for b in blocks:
            if cur_blocks and (cur_len + len(b) > max_chars_per_page or (b.startswith("#") and cur_len > 140)):
                page_md = "\n\n".join(cur_blocks)
                final_pages.append((extract_book_heading(page_md, base_title), page_md))
                cur_blocks = [b]
                cur_len = len(b)
            else:
                cur_blocks.append(b)
                cur_len += len(b) + 2

        if cur_blocks:
            page_md = "\n\n".join(cur_blocks)
            final_pages.append((extract_book_heading(page_md, base_title), page_md))

    return final_pages or [(fallback_title, md.strip())]


@app.post("/api/books/create")
async def create_book(req: BookCreateRequest, user_name: str = Depends(get_request_user)) -> dict[str, Any]:
    topic = req.topic.strip()
    if not topic:
        raise HTTPException(status_code=400, detail="教科書のテーマを入力してください。")

    emb = await get_embedding(topic, is_query=True)
    # 関連するRAG・記憶ノートを最大20件取得
    related = db.search_similar_memories(emb, top_k=20, min_score=0.40, user_name=user_name)

    if related:
        rag_block = (
            f"【生徒の過去のつまずき・RAG記憶（全{len(related)}件）】\n"
            + format_memory_items(related)
        )
    else:
        rag_block = "【生徒の過去のRAG記憶】該当記録はまだ少ないため、このテーマの基礎〜つまずきやすいポイントを網羅した教科書を作成してください。"

    system_prompt = (
        "あなたは紙の教科書を執筆するAIです。\n"
        "生徒の過去のつまずき・RAG記憶をもとに、**必要な分だけ複数ページ（3〜6ページ程度）に分けて**マークダウンで教科書を作成してください。\n"
        "以下のルールを必ず守ってください：\n"
        "1. ページとページの間は必ず単独行 `===PAGE===` で区切る。\n"
        "2. 1ページは**縦スクロールせずにそのまま1枚に収まる分量（250〜380文字程度）**にコンパクトにまとめる。\n"
        "3. 各ページの先頭行に `# ページタイトル` を書き、見出し・箇条書き・表・引用・数式（`$...$` / `$$...$$`）で見やすく整理する。\n"
        "4. ページ構成の例：P.1 全体像とよくある罠 → P.2 重要ポイント・公式 → P.3 過去ミスに基づく例題と解説 → P.4 まとめチェック。\n"
        "5. 余計な挨拶やメタ行は書かず、教科書本文と `===PAGE===` だけを出力する。"
    )

    user_prompt = (
        f"作成したい教科書のテーマ：{topic}\n\n"
        f"{rag_block}\n\n"
        "上記の過去の記憶を最大限に活かし、1ページごとにスッキリ収まる複数ページの教科書を `===PAGE===` 区切りで執筆してください。"
    )

    content_md = await call_gemma_chat(
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        max_tokens=3200,
    )

    pages = split_markdown_into_pages(content_md, f"{topic} 第1章")
    book_title = f"{topic} 教科書" if "教科書" not in topic else topic
    return db.create_ai_book(
        title=book_title,
        topic=topic,
        based_on_count=len(related),
        pages=pages,
        user_name=user_name,
    )


@app.post("/api/books/{book_id}/pages")
async def add_book_page(book_id: int, req: BookAddPageRequest, user_name: str = Depends(get_request_user)) -> dict[str, Any]:
    book = db.get_ai_book(book_id, user_name=user_name)
    if not book:
        raise HTTPException(status_code=404, detail="指定されたAI本が見つかりません。")

    instruction = req.instruction.strip() or "前のページの続きとして、応用例題やさらに理解が深まる解説ページを追加してください。"
    next_num = len(book.get("pages", [])) + 1
    existing_outline = "\n".join(
        f"- P.{p['page_number']}: {p['chapter_title']}"
        for p in book.get("pages", [])
    )

    query_text = f"{book['topic']} {instruction}"
    emb = await get_embedding(query_text, is_query=True)
    related = db.search_similar_memories(emb, top_k=20, min_score=0.40, user_name=user_name)
    rag_block = (
        f"【関連する過去のRAG記憶（最大20件中 {len(related)}件）】\n" + format_memory_items(related)
        if related
        else "【関連する過去のRAG記憶】なし"
    )

    system_prompt = (
        "あなたは紙の教科書の執筆AIです。既存の教科書に、必要な分だけ新しいページ（1〜4ページ）を追加執筆してください。\n"
        "ルール：\n"
        "1. 複数ページになるときは必ず単独行 `===PAGE===` で区切る。\n"
        "2. 1ページは縦スクロール不要な分量（250〜380文字程度）にスッキリ収める。\n"
        "3. 各ページの先頭に `# タイトル` を書き、既存ページと重複しない内容でマークダウン（表・引用・数式 `$...$` / `$$...$$`・例題）で見やすくまとめる。"
    )

    user_prompt = (
        f"教科書タイトル: {book['title']}\n"
        f"既存のページ目次:\n{existing_outline}\n\n"
        f"今回追加開始するページ番号: P.{next_num}\n"
        f"追加ページのリクエスト: {instruction}\n\n"
        f"{rag_block}\n\n"
        "上記を踏まえて必要なページ数だけ `===PAGE===` 区切りで執筆してください。"
    )

    content_md = await call_gemma_chat(
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        max_tokens=3000,
    )

    new_pages_tuples = split_markdown_into_pages(content_md, f"P.{next_num} {instruction[:20]}")
    added_pages = db.add_ai_book_pages(book_id, new_pages_tuples)
    updated_book = db.get_ai_book(book_id, user_name=user_name)
    return {"pages": added_pages, "book": updated_book}
