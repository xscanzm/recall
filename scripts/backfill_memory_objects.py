#!/usr/bin/env python3
"""Backfill Recall L3 memory objects from existing facts and Linker outputs.

This script is intentionally conservative:
- It creates a SQLite backup before writing.
- It is idempotent by object name/title.
- It prefers failed Linker raw outputs, then falls back to fact hints.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VALID_OBJECT_TYPES = {"project", "task", "person", "decision"}
VALID_TASK_STATUSES = {"open", "in_progress", "likely_done", "done", "blocked", "unknown"}
SKIP_HINTS = {
    "",
    "unknown",
    "none",
    "null",
    "n/a",
    "na",
    "无",
    "未知",
    "未确定",
    "用户",
    "同事",
    "朋友",
    "客户",
    "联系人",
    "deepseek",
    "xscanzm",
    "当前窗口",
    "浏览器",
    "chrome",
    "powershell",
    "vscode",
    "visual studio code",
}

PERSON_TITLE_BLOCKLIST = (
    "项目",
    "系统",
    "应用",
    "平台",
    "模型",
    "api",
    "agent",
    "代理",
    "助手",
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def gen_id(prefix: str) -> str:
    millis = int(time.time() * 1000)
    rand = "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(8))
    return f"{prefix}_{base36(millis)}_{rand}"


def base36(value: int) -> str:
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value == 0:
        return "0"
    out = []
    while value:
        value, rem = divmod(value, 36)
        out.append(chars[rem])
    return "".join(reversed(out))


def normalize_name(value: str | None) -> str:
    if not value:
        return ""
    text = value.strip().lower()
    text = re.sub(r"\s+", "", text)
    text = text.strip("'\"`.,;:!?()[]{}<>|/\\")
    return text


def clean_title(value: Any, limit: int = 120) -> str:
    if not isinstance(value, str):
        return ""
    text = re.sub(r"\s+", " ", value).strip()
    return text[:limit]


def clean_summary(value: Any, fallback: str, limit: int = 1000) -> str:
    if isinstance(value, str) and value.strip():
        text = re.sub(r"\s+", " ", value).strip()
    else:
        text = fallback
    return text[:limit]


def safe_json_array(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(x).strip() for x in value if str(x).strip()]
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [str(x).strip() for x in parsed if str(x).strip()]
        except Exception:
            return [text]
        return []
    return []


def json_dumps_array(values: list[str]) -> str:
    return json.dumps(values, ensure_ascii=False, separators=(",", ":"))


def merge_ids(existing_json: str | None, incoming: list[str]) -> list[str]:
    existing = safe_json_array(existing_json)
    seen = set(existing)
    result = list(existing)
    for item in incoming:
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


def strip_json_fence(text: str) -> str:
    trimmed = text.strip()
    if trimmed.startswith("```"):
        first_newline = trimmed.find("\n")
        if first_newline >= 0:
            trimmed = trimmed[first_newline + 1 :]
        if trimmed.rstrip().endswith("```"):
            trimmed = trimmed.rstrip()[:-3]
    return trimmed.strip()


def parse_json_output(text: str | None) -> dict[str, Any] | None:
    if not text:
        return None
    try:
        parsed = json.loads(strip_json_fence(text))
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def first(obj: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        if key in obj and obj[key] is not None:
            return obj[key]
    return None


def clamp01(value: Any, default: float = 0.6) -> float:
    try:
        n = float(value)
    except Exception:
        n = default
    return max(0.0, min(1.0, n))


def is_good_hint(value: str) -> bool:
    key = normalize_name(value)
    if key in SKIP_HINTS:
        return False
    if len(key) < 2:
        return False
    if len(value.strip()) > 80:
        return False
    return True


def is_good_person_name(value: str) -> bool:
    if not is_good_hint(value):
        return False
    key = normalize_name(value)
    if any(token in key for token in PERSON_TITLE_BLOCKLIST):
        return False
    return True


class Backfiller:
    def __init__(self, db_path: Path, args: argparse.Namespace) -> None:
        self.db_path = db_path
        self.args = args
        self.conn = sqlite3.connect(str(db_path))
        self.conn.row_factory = sqlite3.Row
        self.fact_ids: set[str] = set()
        self.facts_by_id: dict[str, sqlite3.Row] = {}
        self.projects: dict[str, sqlite3.Row] = {}
        self.people: dict[str, sqlite3.Row] = {}
        self.tasks: dict[str, sqlite3.Row] = {}
        self.decisions: dict[str, sqlite3.Row] = {}
        self.stats = Counter()

    def close(self) -> None:
        self.conn.close()

    def load_state(self) -> None:
        self.fact_ids.clear()
        self.facts_by_id.clear()
        for row in self.conn.execute("SELECT * FROM facts WHERE deleted_at IS NULL"):
            self.fact_ids.add(row["id"])
            self.facts_by_id[row["id"]] = row
        self.projects = self._load_named("projects", "name", "archived_at IS NULL")
        self.people = self._load_named("people", "name", "deleted_at IS NULL")
        self.tasks = self._load_named("tasks", "title", "deleted_at IS NULL")
        self.decisions = self._load_named("decisions", "title", "deleted_at IS NULL")

    def _load_named(self, table: str, name_col: str, where: str) -> dict[str, sqlite3.Row]:
        result: dict[str, sqlite3.Row] = {}
        for row in self.conn.execute(f"SELECT * FROM {table} WHERE {where}"):
            result[normalize_name(row[name_col])] = row
        return result

    def valid_fact_ids(self, raw: Any) -> list[str]:
        ids = safe_json_array(raw)
        return [x for x in ids if x in self.fact_ids]

    def upsert_project(self, title: str, summary: str, fact_ids: list[str]) -> str | None:
        title = clean_title(title)
        if not title or not is_good_hint(title) or not fact_ids:
            return None
        key = normalize_name(title)
        existing = self.projects.get(key)
        now = now_iso()
        if existing:
            merged = merge_ids(existing["source_fact_ids_json"], fact_ids)
            self.conn.execute(
                "UPDATE projects SET source_fact_ids_json = ?, last_active_at = ?, updated_at = ? WHERE id = ?",
                (json_dumps_array(merged), now, now, existing["id"]),
            )
            project_id = existing["id"]
            self.stats["projects_linked"] += 1
        else:
            project_id = gen_id("proj")
            self.conn.execute(
                """INSERT INTO projects
                (id, name, summary, status, last_active_at, source_fact_ids_json, source_scene_ids_json, created_at, updated_at)
                VALUES (?, ?, ?, 'active', ?, ?, '[]', ?, ?)""",
                (project_id, title, clean_summary(summary, title), now, json_dumps_array(fact_ids), now, now),
            )
            self.projects[key] = self.conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            self.stats["projects_created"] += 1
        self.conn.executemany(
            "UPDATE facts SET project_id = ?, updated_at = ? WHERE id = ? AND project_id IS NULL",
            [(project_id, now, fid) for fid in fact_ids],
        )
        return project_id

    def upsert_person(self, title: str, summary: str, fact_ids: list[str]) -> str | None:
        title = clean_title(title)
        if not title or not is_good_person_name(title) or not fact_ids:
            return None
        key = normalize_name(title)
        existing = self.people.get(key)
        now = now_iso()
        if existing:
            merged = merge_ids(existing["source_fact_ids_json"], fact_ids)
            self.conn.execute(
                "UPDATE people SET source_fact_ids_json = ?, updated_at = ? WHERE id = ?",
                (json_dumps_array(merged), now, existing["id"]),
            )
            person_id = existing["id"]
            self.stats["people_linked"] += 1
        else:
            person_id = gen_id("person")
            self.conn.execute(
                """INSERT INTO people
                (id, name, role, organization, summary, related_project_ids_json, source_fact_ids_json, created_at, updated_at)
                VALUES (?, ?, NULL, NULL, ?, '[]', ?, ?, ?)""",
                (person_id, title, clean_summary(summary, title), json_dumps_array(fact_ids), now, now),
            )
            self.people[key] = self.conn.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
            self.stats["people_created"] += 1
        return person_id

    def upsert_task(self, title: str, summary: str, fact_ids: list[str], project_hint: str | None = None, status: str | None = None, confidence: float = 0.6) -> str | None:
        title = clean_title(title)
        if not title or not fact_ids:
            return None
        key = normalize_name(title)
        existing = self.tasks.get(key)
        now = now_iso()
        project_id = self.resolve_project_id(project_hint)
        task_status = status if status in VALID_TASK_STATUSES else "open"
        if existing:
            merged = merge_ids(existing["source_fact_ids_json"], fact_ids)
            self.conn.execute(
                "UPDATE tasks SET source_fact_ids_json = ?, updated_at = ? WHERE id = ?",
                (json_dumps_array(merged), now, existing["id"]),
            )
            task_id = existing["id"]
            self.stats["tasks_linked"] += 1
        else:
            task_id = gen_id("task")
            self.conn.execute(
                """INSERT INTO tasks
                (id, title, status, project_id, summary, due_hint, priority, confidence, source_fact_ids_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)""",
                (task_id, title, task_status, project_id, clean_summary(summary, title), confidence, confidence, json_dumps_array(fact_ids), now, now),
            )
            self.tasks[key] = self.conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            self.stats["tasks_created"] += 1
        return task_id

    def upsert_decision(self, title: str, summary: str, fact_ids: list[str], confidence: float = 0.6) -> str | None:
        title = clean_title(title)
        if not title or not fact_ids:
            return None
        key = normalize_name(title)
        existing = self.decisions.get(key)
        now = now_iso()
        if existing:
            merged = merge_ids(existing["source_fact_ids_json"], fact_ids)
            self.conn.execute(
                "UPDATE decisions SET source_fact_ids_json = ?, updated_at = ? WHERE id = ?",
                (json_dumps_array(merged), now, existing["id"]),
            )
            decision_id = existing["id"]
            self.stats["decisions_linked"] += 1
        else:
            decision_id = gen_id("decision")
            self.conn.execute(
                """INSERT INTO decisions
                (id, title, decision, project_id, rationale, confidence, source_fact_ids_json, decided_at, created_at, updated_at)
                VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)""",
                (decision_id, title, clean_summary(summary, title), confidence, json_dumps_array(fact_ids), now, now, now),
            )
            self.decisions[key] = self.conn.execute("SELECT * FROM decisions WHERE id = ?", (decision_id,)).fetchone()
            self.stats["decisions_created"] += 1
        return decision_id

    def resolve_project_id(self, project_hint: str | None) -> str | None:
        if not project_hint:
            return None
        key = normalize_name(project_hint)
        if key in self.projects:
            return self.projects[key]["id"]
        for existing_key, row in self.projects.items():
            if key and (key in existing_key or existing_key in key):
                return row["id"]
        return None

    def apply_linker_outputs(self) -> None:
        rows = self.conn.execute(
            """SELECT id, output_json FROM model_jobs
            WHERE type = 'linker' AND output_json IS NOT NULL
            ORDER BY created_at ASC"""
        ).fetchall()
        for row in rows:
            data = parse_json_output(row["output_json"])
            if not data:
                continue
            for obj in data.get("newObjects") or []:
                if not isinstance(obj, dict):
                    continue
                object_type = first(obj, ["objectType", "targetType", "type", "kind"])
                if object_type not in VALID_OBJECT_TYPES:
                    continue
                title = clean_title(first(obj, ["title", "name", "displayName"]))
                fact_ids = self.valid_fact_ids(first(obj, ["sourceFactIds", "factIds", "sourceFactId", "factId"]))
                if not title or not fact_ids:
                    continue
                summary = clean_summary(first(obj, ["summary", "description", "reason", "rationale"]), title)
                confidence = clamp01(first(obj, ["confidence", "score"]), 0.65)
                project_hint = clean_title(first(obj, ["projectHint", "project", "projectName"])) or None
                if object_type == "project":
                    self.upsert_project(title, summary, fact_ids)
                elif object_type == "person":
                    self.upsert_person(title, summary, fact_ids)
                elif object_type == "task":
                    self.upsert_task(title, summary, fact_ids, project_hint=project_hint, confidence=confidence)
                elif object_type == "decision":
                    self.upsert_decision(title, summary, fact_ids, confidence=confidence)

    def fallback_from_project_hints(self) -> None:
        grouped: dict[str, list[sqlite3.Row]] = defaultdict(list)
        display_names: dict[str, Counter[str]] = defaultdict(Counter)
        for row in self.facts_by_id.values():
            hint = clean_title(row["project_hint"])
            if not hint or not is_good_hint(hint):
                continue
            key = normalize_name(hint)
            grouped[key].append(row)
            display_names[key][hint] += 1
        items = sorted(grouped.items(), key=lambda item: len(item[1]), reverse=True)
        created = 0
        for key, facts in items:
            if created >= self.args.max_projects:
                break
            if key in self.projects:
                continue
            if len(facts) < self.args.min_project_facts:
                continue
            title = display_names[key].most_common(1)[0][0]
            fact_ids = [row["id"] for row in facts[: self.args.max_fact_links_per_object]]
            examples = [row["content"] for row in facts[:3]]
            summary = f"根据 {len(facts)} 条历史事实回填。代表事实：" + "；".join(examples)
            if self.upsert_project(title, summary, fact_ids):
                created += 1

    def fallback_from_people_hints(self) -> None:
        grouped: dict[str, list[sqlite3.Row]] = defaultdict(list)
        display_names: dict[str, Counter[str]] = defaultdict(Counter)
        for row in self.facts_by_id.values():
            for hint in safe_json_array(row["people_hints_json"]):
                name = clean_title(hint)
                if not name or not is_good_person_name(name):
                    continue
                key = normalize_name(name)
                grouped[key].append(row)
                display_names[key][name] += 1
        items = sorted(grouped.items(), key=lambda item: len(item[1]), reverse=True)
        created = 0
        for key, facts in items:
            if created >= self.args.max_people:
                break
            if key in self.people:
                continue
            if len(facts) < self.args.min_people_facts:
                continue
            title = display_names[key].most_common(1)[0][0]
            fact_ids = [row["id"] for row in facts[: self.args.max_fact_links_per_object]]
            examples = [row["content"] for row in facts[:3]]
            summary = f"根据 {len(facts)} 条历史事实回填。代表事实：" + "；".join(examples)
            if self.upsert_person(title, summary, fact_ids):
                created += 1

    def fallback_tasks_and_decisions(self) -> None:
        task_rows = [r for r in self.facts_by_id.values() if r["type"] == "task" and float(r["importance"] or 0) >= self.args.min_task_importance]
        task_rows.sort(key=lambda r: (float(r["importance"] or 0), r["created_at"]), reverse=True)
        for row in task_rows[: self.args.max_tasks]:
            status = row["status"] if row["status"] in VALID_TASK_STATUSES else "open"
            self.upsert_task(
                row["content"],
                row["content"],
                [row["id"]],
                project_hint=row["project_hint"],
                status=status,
                confidence=clamp01(row["confidence"], 0.6),
            )

        decision_rows = [r for r in self.facts_by_id.values() if r["type"] == "decision" and float(r["importance"] or 0) >= self.args.min_decision_importance]
        decision_rows.sort(key=lambda r: (float(r["importance"] or 0), r["created_at"]), reverse=True)
        for row in decision_rows[: self.args.max_decisions]:
            self.upsert_decision(
                row["content"],
                row["content"],
                [row["id"]],
                confidence=clamp01(row["confidence"], 0.6),
            )

    def counts(self) -> dict[str, int]:
        result: dict[str, int] = {}
        for table in ["projects", "people", "tasks", "decisions"]:
            result[table] = int(self.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        return result

    def run(self) -> dict[str, Any]:
        before = self.counts()
        self.load_state()
        if self.args.dry_run:
            self.conn.execute("BEGIN")
        else:
            self.conn.execute("BEGIN IMMEDIATE")
        try:
            self.apply_linker_outputs()
            self.fallback_from_project_hints()
            self.fallback_from_people_hints()
            self.fallback_tasks_and_decisions()
            after = self.counts()
            if self.args.dry_run:
                self.conn.rollback()
            else:
                self.conn.commit()
            return {
                "dbPath": str(self.db_path),
                "dryRun": bool(self.args.dry_run),
                "before": before,
                "after": after,
                "changes": dict(self.stats),
            }
        except Exception:
            self.conn.rollback()
            raise


def default_db_path() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("APPDATA is not set; pass --db explicitly")
    return Path(appdata) / "recall" / "data" / "recall.db"


def backup_database(db_path: Path) -> Path:
    backup_path = db_path.with_name(f"{db_path.name}.bak.backfill-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
    src = sqlite3.connect(str(db_path))
    try:
        dst = sqlite3.connect(str(backup_path))
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    return backup_path


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill Recall L3 memory objects from historical data")
    parser.add_argument("--db", type=Path, default=default_db_path())
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--min-project-facts", type=int, default=3)
    parser.add_argument("--min-people-facts", type=int, default=1)
    parser.add_argument("--min-task-importance", type=float, default=0.65)
    parser.add_argument("--min-decision-importance", type=float, default=0.65)
    parser.add_argument("--max-projects", type=int, default=80)
    parser.add_argument("--max-people", type=int, default=100)
    parser.add_argument("--max-tasks", type=int, default=160)
    parser.add_argument("--max-decisions", type=int, default=100)
    parser.add_argument("--max-fact-links-per-object", type=int, default=80)
    parser.add_argument("--no-backup", action="store_true", help="Skip backup before writing. Not recommended.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    db_path = args.db
    if not db_path.exists():
        print(f"Database not found: {db_path}", file=sys.stderr)
        return 2

    backup_path = None
    if not args.dry_run and not args.no_backup:
        backup_path = backup_database(db_path)

    backfiller = Backfiller(db_path, args)
    try:
        result = backfiller.run()
    finally:
        backfiller.close()

    if backup_path:
        result["backupPath"] = str(backup_path)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
