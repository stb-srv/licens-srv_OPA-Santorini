import mysql from 'mysql2/promise';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrate() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || '127.0.0.1',
        port: parseInt(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '',
        database: process.env.DB_NAME || 'opa_licenses',
        multipleStatements: true
    });

    console.log('\n🚀 Starting Database Migrations...');

    try {
        // 1. Ensure migrations table exists
        await connection.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
                version    VARCHAR(255) NOT NULL UNIQUE,
                name       VARCHAR(255) NOT NULL,
                applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

        // 2. Get applied migrations
        const [appliedRows] = await connection.query('SELECT version FROM schema_migrations');
        const appliedVersions = new Set(appliedRows.map(r => r.version));

        // 3. Read migration files
        const files = await fs.readdir(MIGRATIONS_DIR);
        const migrationFiles = files
            .filter(f => f.endsWith('.sql') || f.endsWith('.js'))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

        let count = 0;
        for (const file of migrationFiles) {
            const version = file; // Use filename as version key
            if (appliedVersions.has(version)) {
                continue;
            }

            console.log(`  ⏳ Applying ${file}...`);
            
            if (file.endsWith('.sql')) {
                const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
                await connection.query(sql);
            } else if (file.endsWith('.js')) {
                const migrationModule = await import(`file://${path.join(MIGRATIONS_DIR, file)}`);
                if (typeof migrationModule.default === 'function') {
                    await migrationModule.default(connection);
                } else {
                    console.warn(`  ⚠️  Migration ${file} has no default export function.`);
                }
            }

            // Record migration
            await connection.query(
                'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
                [version, file]
            );
            console.log(`  ✅ ${file} applied.`);
            count++;
        }

        if (count === 0) {
            console.log('✨ Database is already up to date.');
        } else {
            console.log(`\n🎉 Successfully applied ${count} migration(s).`);
        }
    } catch (e) {
        console.error('\n❌ Error during migration:', e.stack);
        process.exit(1);
    } finally {
        await connection.end();
    }
}

migrate();
