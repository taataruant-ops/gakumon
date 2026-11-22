import json
import sqlite3
from pathlib import Path
from typing import Any

import numpy as np

DB_PATH = Path(__file__).parent / "mistakes.db"
DEFAULT_USER = "default"


def normalize_user(user_name: str | None) -> str:
    clean = (user_name or "").strip()[:40]
    return clean or DEFAULT_USER


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_user_column(conn: sqlite3.Connection, table: str) -> None:
    cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    if "user_name" not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN user_name TEXT NOT NULL DEFAULT 'default'")


def init_db() -> None:
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS mistakes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_name TEXT NOT NULL DEFAULT 'default',
                question_text TEXT NOT NULL,
                mistake_point TEXT NOT NULL,
                subject_tag TEXT NOT NULL DEFAULT '',
                explanation TEXT NOT NULL DEFAULT '',
                image_data TEXT NOT NULL DEFAULT '',
                embedding TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS rag_memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_name TEXT NOT NULL DEFAULT 'default',
                question_text TEXT NOT NULL,
                explanation TEXT NOT NULL,
                subject_tag TEXT NOT NULL DEFAULT '',
                key_point TEXT NOT NULL DEFAULT '',
                embedding TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ai_books (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_name TEXT NOT NULL DEFAULT 'default',
                title TEXT NOT NULL,
                topic TEXT NOT NULL,
                based_on_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ai_book_pages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                book_id INTEGER NOT NULL,
                page_number INTEGER NOT NULL,
                chapter_title TEXT NOT NULL,
                content_md TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (book_id) REFERENCES ai_books(id) ON DELETE CASCADE
            )
            """
        )
        _ensure_user_column(conn, "mistakes")
        _ensure_user_column(conn, "rag_memories")
        _ensure_user_column(conn, "ai_books")
        conn.commit()


def list_users() -> list[str]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT DISTINCT user_name FROM rag_memories
            UNION
            SELECT DISTINCT user_name FROM mistakes
            UNION
            SELECT DISTINCT user_name FROM ai_books
            ORDER BY user_name ASC
            """
        ).fetchall()
    return [str(r["user_name"]) for r in rows if (r["user_name"] or "").strip()]


def add_mistake(
    question_text: str,
    mistake_point: str,
    subject_tag: str,
    explanation: str,
    image_data: str,
    embedding: list[float],
    user_name: str = DEFAULT_USER,
) -> int:
    u = normalize_user(user_name)
    with get_conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO mistakes (
                user_name, question_text, mistake_point, subject_tag, explanation, image_data, embedding
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                u,
                question_text,
                mistake_point,
                subject_tag,
                explanation,
                image_data,
                json.dumps(embedding),
            ),
        )
        conn.commit()
        return int(cur.lastrowid)


def add_rag_memory(
    question_text: str,
    explanation: str,
    subject_tag: str,
    key_point: str,
    embedding: list[float],
    user_name: str = DEFAULT_USER,
) -> int:
    u = normalize_user(user_name)
    with get_conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO rag_memories (
                user_name, question_text, explanation, subject_tag, key_point, embedding
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                u,
                question_text,
                explanation,
                subject_tag,
                key_point,
                json.dumps(embedding),
            ),
        )
        conn.commit()
        return int(cur.lastrowid)


def list_mistakes(user_name: str = DEFAULT_USER) -> list[dict[str, Any]]:
    u = normalize_user(user_name)
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, question_text, mistake_point, subject_tag, explanation, image_data, created_at
            FROM mistakes
            WHERE user_name = ?
            ORDER BY id DESC
            """,
            (u,),
        ).fetchall()
    return [dict(r) for r in rows]


def list_rag_memories(user_name: str = DEFAULT_USER) -> list[dict[str, Any]]:
    u = normalize_user(user_name)
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, question_text, explanation, subject_tag, key_point, created_at
            FROM rag_memories
            WHERE user_name = ?
            ORDER BY id DESC
            """,
            (u,),
        ).fetchall()
    return [dict(r) for r in rows]


def delete_mistake(mistake_id: int, user_name: str = DEFAULT_USER) -> bool:
    u = normalize_user(user_name)
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM mistakes WHERE id = ? AND user_name = ?", (mistake_id, u))
        conn.commit()
        return cur.rowcount > 0


def delete_rag_memory(memory_id: int, user_name: str = DEFAULT_USER) -> bool:
    u = normalize_user(user_name)
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM rag_memories WHERE id = ? AND user_name = ?", (memory_id, u))
        conn.commit()
        return cur.rowcount > 0


def get_rag_map(user_name: str = DEFAULT_USER) -> dict[str, Any]:
    """指定ユーザーの全RAG記憶とつまずき記録を、最後に入力した意味を基準とした2D座標・類似度付きで返す。"""
    u = normalize_user(user_name)
    with get_conn() as conn:
        rag_rows = conn.execute(
            """
            SELECT id, question_text, explanation, subject_tag, key_point, created_at, embedding
            FROM rag_memories
            WHERE user_name = ?
            ORDER BY id ASC
            """,
            (u,),
        ).fetchall()
        mistake_rows = conn.execute(
            """
            SELECT id, question_text, explanation, subject_tag, mistake_point AS key_point, created_at, embedding
            FROM mistakes
            WHERE user_name = ?
            ORDER BY id ASC
            """,
            (u,),
        ).fetchall()

    items: list[dict[str, Any]] = []
    vectors: list[np.ndarray] = []

    for r in rag_rows:
        vec = np.array(json.loads(r["embedding"]), dtype=np.float32)
        norm = np.linalg.norm(vec)
        if norm == 0:
            continue
        vectors.append(vec / norm)
        items.append({
            "uid": f"rag-{r['id']}",
            "id": r["id"],
            "source": "rag",
            "question_text": r["question_text"],
            "explanation": r["explanation"],
            "subject_tag": r["subject_tag"] or "未分類",
            "key_point": r["key_point"],
            "created_at": r["created_at"],
        })

    for r in mistake_rows:
        vec = np.array(json.loads(r["embedding"]), dtype=np.float32)
        norm = np.linalg.norm(vec)
        if norm == 0:
            continue
        vectors.append(vec / norm)
        items.append({
            "uid": f"mistake-{r['id']}",
            "id": r["id"],
            "source": "mistake",
            "question_text": r["question_text"],
            "explanation": r["explanation"],
            "subject_tag": r["subject_tag"] or "未分類",
            "key_point": r["key_point"],
            "created_at": r["created_at"],
        })

    if not items:
        return {"anchor_uid": None, "nodes": []}

    # 最後に入力したRAG（なければ最後の記憶）を基準（磁石の中心）にする
    anchor_idx = len(rag_rows) - 1 if rag_rows else len(items) - 1
    anchor_vec = vectors[anchor_idx]
    mat = np.stack(vectors, axis=0)
    sims = mat @ anchor_vec

    # 意味が近いもの同士が近くに集まるよう、SVDで2D方向を算出
    if len(items) >= 3:
        centered = mat - mat.mean(axis=0, keepdims=True)
        _, _, vt = np.linalg.svd(centered, full_matrices=False)
        coords2d = centered @ vt[:2].T
    elif len(items) == 2:
        coords2d = np.array([[0.0, 0.0], [1.0, 0.0]], dtype=np.float32)
    else:
        coords2d = np.array([[0.0, 0.0]], dtype=np.float32)

    # 基準ベクトルとの類似度が高いほど中心（0,0）に近く、似たもの同士が同じ方向へ集まる配置
    nodes: list[dict[str, Any]] = []
    for i, item in enumerate(items):
        sim = float(np.clip(sims[i], -1.0, 1.0))
        is_anchor = i == anchor_idx
        if is_anchor:
            nx, ny = 0.0, 0.0
        else:
            vx, vy = float(coords2d[i, 0]), float(coords2d[i, 1])
            vlen = float(np.hypot(vx, vy))
            if vlen < 1e-6:
                angle = (i * 2.39996) % (2.0 * np.pi)
                ux, uy = float(np.cos(angle)), float(np.sin(angle))
            else:
                ux, uy = vx / vlen, vy / vlen
            # 類似度が高いほど中心に引き寄せられる距離 (0.12 〜 0.95)
            dist = float(np.clip((1.0 - sim) * 1.45, 0.14, 0.95))
            nx, ny = ux * dist, uy * dist

        item["similarity_to_latest"] = round(sim, 4)
        item["is_latest"] = is_anchor
        item["x"] = round(nx, 4)
        item["y"] = round(ny, 4)
        nodes.append(item)

    return {
        "anchor_uid": items[anchor_idx]["uid"],
        "nodes": nodes,
    }


def _score_rows(
    q: np.ndarray,
    rows: list[sqlite3.Row],
    *,
    source: str,
    min_score: float,
) -> list[tuple[float, dict[str, Any]]]:
    scored: list[tuple[float, dict[str, Any]]] = []
    for row in rows:
        vec = np.array(json.loads(row["embedding"]), dtype=np.float32)
        v_norm = np.linalg.norm(vec)
        if v_norm == 0:
            continue
        score = float(np.dot(q, vec / v_norm))
        if score >= min_score:
            item = dict(row)
            item.pop("embedding", None)
            item["similarity"] = round(score, 4)
            item["source"] = source
            scored.append((score, item))
    return scored


def search_similar_memories(
    query_embedding: list[float],
    top_k: int = 3,
    min_score: float = 0.60,
    user_name: str = DEFAULT_USER,
) -> list[dict[str, Any]]:
    u = normalize_user(user_name)
    with get_conn() as conn:
        mistake_rows = conn.execute(
            """
            SELECT id, question_text, mistake_point, subject_tag, explanation, created_at, embedding
            FROM mistakes
            WHERE user_name = ?
            """,
            (u,),
        ).fetchall()
        rag_rows = conn.execute(
            """
            SELECT id, question_text, key_point AS mistake_point, subject_tag, explanation, created_at, embedding
            FROM rag_memories
            WHERE user_name = ?
            """,
            (u,),
        ).fetchall()

    q = np.array(query_embedding, dtype=np.float32)
    q_norm = np.linalg.norm(q)
    if q_norm == 0:
        return []
    q = q / q_norm

    scored = _score_rows(q, mistake_rows, source="mistake", min_score=min_score)
    scored.extend(_score_rows(q, rag_rows, source="rag", min_score=min_score))
    scored.sort(key=lambda x: x[0], reverse=True)

    # 同じ問題文の重複（自動RAGと手動ピン留めの両方がある場合など）は上位を優先してまとめる
    deduped: list[dict[str, Any]] = []
    seen_questions: set[str] = set()
    for _, item in scored:
        key = item["question_text"].strip()
        if key in seen_questions:
            continue
        seen_questions.add(key)
        deduped.append(item)
        if len(deduped) >= top_k:
            break
    return deduped


def search_recent_in_range(
    query_embedding: list[float],
    start_date: str,
    end_date: str,
    min_score: float = 0.45,
    user_name: str = DEFAULT_USER,
) -> dict[str, Any] | None:
    """指定期間内で意味が近い（似た分野の）記録のうち、もっとも最近の1件を返す。"""
    u = normalize_user(user_name)
    start_ts = f"{start_date.strip()} 00:00:00"
    end_ts = f"{end_date.strip()} 23:59:59"

    with get_conn() as conn:
        rag_rows = conn.execute(
            """
            SELECT id, question_text, key_point AS mistake_point, subject_tag, explanation, created_at, embedding
            FROM rag_memories
            WHERE user_name = ? AND created_at >= ? AND created_at <= ?
            ORDER BY created_at DESC, id DESC
            """,
            (u, start_ts, end_ts),
        ).fetchall()
        mistake_rows = conn.execute(
            """
            SELECT id, question_text, mistake_point, subject_tag, explanation, created_at, embedding
            FROM mistakes
            WHERE user_name = ? AND created_at >= ? AND created_at <= ?
            ORDER BY created_at DESC, id DESC
            """,
            (u, start_ts, end_ts),
        ).fetchall()

    all_rows = [(r, "rag") for r in rag_rows] + [(r, "mistake") for r in mistake_rows]
    if not all_rows:
        return None

    q = np.array(query_embedding, dtype=np.float32)
    q_norm = np.linalg.norm(q)
    if q_norm == 0:
        return None
    q = q / q_norm

    candidates: list[dict[str, Any]] = []
    best_fallback: tuple[float, dict[str, Any]] | None = None

    for row, source in all_rows:
        vec = np.array(json.loads(row["embedding"]), dtype=np.float32)
        v_norm = np.linalg.norm(vec)
        if v_norm == 0:
            continue
        score = float(np.dot(q, vec / v_norm))
        item = dict(row)
        item.pop("embedding", None)
        item["similarity"] = round(score, 4)
        item["source"] = source

        if best_fallback is None or score > best_fallback[0]:
            best_fallback = (score, item)
        if score >= min_score:
            candidates.append(item)

    if candidates:
        # 似た分野の中で「もっとも最近（created_at DESC）」のものを返す
        candidates.sort(key=lambda x: (x.get("created_at") or "", x.get("id") or 0), reverse=True)
        return candidates[0]

    return best_fallback[1] if best_fallback else None


def create_ai_book(
    title: str,
    topic: str,
    based_on_count: int,
    pages: list[tuple[str, str]],
    user_name: str = DEFAULT_USER,
) -> dict[str, Any]:
    u = normalize_user(user_name)
    with get_conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO ai_books (user_name, title, topic, based_on_count)
            VALUES (?, ?, ?, ?)
            """,
            (u, title, topic, based_on_count),
        )
        book_id = int(cur.lastrowid)
        for idx, (chapter_title, content_md) in enumerate(pages, 1):
            conn.execute(
                """
                INSERT INTO ai_book_pages (book_id, page_number, chapter_title, content_md)
                VALUES (?, ?, ?, ?)
                """,
                (book_id, idx, chapter_title, content_md),
            )
        conn.commit()
    return get_ai_book(book_id, user_name=u)  # type: ignore[return-value]


def add_ai_book_pages(book_id: int, pages: list[tuple[str, str]]) -> list[dict[str, Any]]:
    added: list[dict[str, Any]] = []
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COALESCE(MAX(page_number), 0) AS max_p FROM ai_book_pages WHERE book_id = ?",
            (book_id,),
        ).fetchone()
        next_page = int(row["max_p"]) + 1 if row else 1
        for chapter_title, content_md in pages:
            cur = conn.execute(
                """
                INSERT INTO ai_book_pages (book_id, page_number, chapter_title, content_md)
                VALUES (?, ?, ?, ?)
                """,
                (book_id, next_page, chapter_title, content_md),
            )
            page_id = int(cur.lastrowid)
            next_page += 1
            p = conn.execute(
                "SELECT id, book_id, page_number, chapter_title, content_md, created_at FROM ai_book_pages WHERE id = ?",
                (page_id,),
            ).fetchone()
            added.append(dict(p))
        conn.commit()
    return added


def list_ai_books(user_name: str = DEFAULT_USER) -> list[dict[str, Any]]:
    u = normalize_user(user_name)
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT b.id, b.title, b.topic, b.based_on_count, b.created_at,
                   COUNT(p.id) AS page_count
            FROM ai_books b
            LEFT JOIN ai_book_pages p ON p.book_id = b.id
            WHERE b.user_name = ?
            GROUP BY b.id
            ORDER BY b.id DESC
            """,
            (u,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_ai_book(book_id: int, user_name: str | None = None) -> dict[str, Any] | None:
    with get_conn() as conn:
        if user_name is not None:
            u = normalize_user(user_name)
            book = conn.execute(
                "SELECT id, title, topic, based_on_count, created_at FROM ai_books WHERE id = ? AND user_name = ?",
                (book_id, u),
            ).fetchone()
        else:
            book = conn.execute(
                "SELECT id, title, topic, based_on_count, created_at FROM ai_books WHERE id = ?",
                (book_id,),
            ).fetchone()
        if not book:
            return None
        pages = conn.execute(
            """
            SELECT id, book_id, page_number, chapter_title, content_md, created_at
            FROM ai_book_pages
            WHERE book_id = ?
            ORDER BY page_number ASC
            """,
            (book_id,),
        ).fetchall()
    res = dict(book)
    res["pages"] = [dict(p) for p in pages]
    return res


def delete_ai_book(book_id: int, user_name: str = DEFAULT_USER) -> bool:
    u = normalize_user(user_name)
    with get_conn() as conn:
        row = conn.execute("SELECT id FROM ai_books WHERE id = ? AND user_name = ?", (book_id, u)).fetchone()
        if not row:
            return False
        conn.execute("DELETE FROM ai_book_pages WHERE book_id = ?", (book_id,))
        cur = conn.execute("DELETE FROM ai_books WHERE id = ? AND user_name = ?", (book_id, u))
        conn.commit()
        return cur.rowcount > 0
