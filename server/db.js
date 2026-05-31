import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'licens.db');

const database = new Database(DB_PATH);
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');

// Returns [rows] for SELECT, [{ affectedRows, insertId }] for writes.
// This mirrors the mysql2 destructuring pattern: const [rows] = db.query(...)
export function query(sql, params = []) {
    const stmt = database.prepare(sql);
    const trimmed = sql.trimStart().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
        return [stmt.all(params)];
    }
    const info = stmt.run(params);
    return [{ affectedRows: info.changes, insertId: info.lastInsertRowid }];
}

// Wraps a synchronous function in a SQLite transaction.
// All query() calls inside fn() are automatically atomic.
export function runTransaction(fn) {
    return database.transaction(fn)();
}

export function testConnection() {
    database.prepare('SELECT 1').get();
    console.log('✅  SQLite Datenbank verbunden –', DB_PATH);
}

export { database };
export default { query, runTransaction };
