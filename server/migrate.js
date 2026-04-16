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
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        multipleStatements: true
    });

    console.log('🔄 Starte Datenbank-Migrationen...');

    try {
        const files = await fs.readdir(MIGRATIONS_DIR);
        const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();

        for (const file of sqlFiles) {
            console.log(`  ⏳ Führe ${file} aus...`);
            const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
            await connection.query(sql);
            console.log(`  ✅ ${file} abgeschlossen.`);
        }

        console.log('\n🎉 Alle Migrationen erfolgreich ausgeführt.');
    } catch (e) {
        console.error('\n❌ Fehler bei der Migration:', e.message);
        process.exit(1);
    } finally {
        await connection.end();
    }
}

migrate();
