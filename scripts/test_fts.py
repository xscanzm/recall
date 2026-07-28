# -*- coding: utf-8 -*-
import sqlite3

db = sqlite3.connect(":memory:")
db.execute("CREATE VIRTUAL TABLE t USING fts5(title, summary, keywords, tokenize='trigram case_sensitive 0')")
db.execute("INSERT INTO t VALUES ('回声Recall', '桌面记忆', 'PRD-1024')")
db.execute("INSERT INTO t VALUES ('皮皮未来 API', '接口接入', 'API')")
db.execute("INSERT INTO t VALUES ('TDW 1.0 结算系统', '回款周期争议', 'TDW')")
db.execute("INSERT INTO t VALUES ('TDW 2.0 数据平台', '实时流处理', 'TDW')")

def fts_search(query):
    # Safe trigram FTS5 query formatting
    tokens = [t.strip() for t in query.split() if t.strip()]
    if not tokens:
        return []
    formatted = []
    for t in tokens:
      q = t.replace('"', '""')
      formatted.append(f'"{q}"')
    fts_expr = " AND ".join(formatted)
    sql = "SELECT title, summary, bm25(t) as score FROM t WHERE t MATCH ? ORDER BY bm25(t)"
    return db.execute(sql, (fts_expr,)).fetchall()

print("Query '回声R':", db.execute("SELECT title, summary, bm25(t) FROM t WHERE t MATCH '\"回声R\"'").fetchall())
print("Query '皮皮未':", db.execute("SELECT title, summary, bm25(t) FROM t WHERE t MATCH '\"皮皮未\"'").fetchall())
print("Query '皮皮*':", db.execute("SELECT title, summary, bm25(t) FROM t WHERE t MATCH '\"皮皮\"*'").fetchall())
print("Query 'TDW*':", db.execute("SELECT title, summary, bm25(t) FROM t WHERE t MATCH '\"TDW\"*'").fetchall())
