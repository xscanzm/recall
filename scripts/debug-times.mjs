import Database from "better-sqlite3";

const dbPath = "C:\\Users\\Administrator\\AppData\\Roaming\\Recall\\data\\recall.db";
const db = new Database(dbPath);

const date = "2026-07-06";

console.log(`=== observations ${date} ===`);
const obs = db
  .prepare("SELECT id, captured_at, app_name, window_title FROM observations WHERE date(captured_at) = ? ORDER BY captured_at LIMIT 50")
  .all(date);
console.log(JSON.stringify(obs, null, 2));

console.log(`\n=== facts ${date} ===`);
const facts = db
  .prepare("SELECT id, created_at, type, substr(content, 1, 80) as content_preview FROM facts WHERE date(created_at) = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 50")
  .all(date);
console.log(JSON.stringify(facts, null, 2));

console.log(`\n=== scenes ${date} ===`);
const scenes = db
  .prepare("SELECT id, start_at, end_at, title FROM scenes WHERE date(start_at) = ? ORDER BY start_at LIMIT 50")
  .all(date);
console.log(JSON.stringify(scenes, null, 2));

console.log(`\n=== timeline_blocks ${date} ===`);
const blocks = db
  .prepare("SELECT id, title, start_at, end_at FROM timeline_blocks WHERE date_key = ? ORDER BY start_at LIMIT 50")
  .all(date);
console.log(JSON.stringify(blocks, null, 2));

db.close();
