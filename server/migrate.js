import { readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'licens.db');

// Opens or reuses an existing better-sqlite3 Database instance.
// When called from server.js, pass the already-open db instance to avoid
// two connections writing to the same WAL file simultaneously.
export async function runMigrations(existingDb = null) {
    const db = existingDb || new Database(DB_PATH);
    if (!existingDb) {
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
    }

    console.log('\n🚀 Starting Database Migrations...');

    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    TEXT NOT NULL PRIMARY KEY,
            name       TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `);

    const appliedVersions = new Set(
        db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
    );

    const files = await readdir(MIGRATIONS_DIR);
    const migrationFiles = files
        .filter(f => f.endsWith('.js'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    let count = 0;
    for (const file of migrationFiles) {
        if (appliedVersions.has(file)) continue;

        console.log(`  ⏳ Applying ${file}...`);
        try {
            const mod = await import(`file://${path.join(MIGRATIONS_DIR, file)}`);
            const fn = mod.default || mod.up;
            if (typeof fn === 'function') {
                fn(db);
            } else {
                console.warn(`  ⚠️  Migration ${file} hat keine default oder up Funktion.`);
            }
            db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(file, file);
            console.log(`  ✅ ${file} applied.`);
            count++;
        } catch (e) {
            console.error(`\n❌ Migration ${file} fehlgeschlagen:`, e.message);
            if (!existingDb) db.close();
            throw e;
        }
    }

    const alreadyApplied = migrationFiles.filter(f => appliedVersions.has(f)).length;
    if (count === 0) {
        console.log('✨ Database is already up to date.');
    } else {
        console.log(`\n🎉 Successfully applied ${count} migration(s).`);
    }
    console.log(`🗄️  Migrationen: ${count} neu ausgeführt, ${alreadyApplied} bereits vorhanden (gesamt ${migrationFiles.length})`);

    if (!existingDb) db.close();
}

// Support direct standalone execution
const isMain = process.argv[1] && (
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) ||
    process.argv[1].endsWith('migrate.js')
);

if (isMain) {
    runMigrations().catch(() => process.exit(1));
}
