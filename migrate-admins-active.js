import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function migrate() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME
    });

    console.log('🔄 Füge Spalte "active" zur Tabelle "admins" hinzu...');

    try {
        await connection.query('ALTER TABLE admins ADD COLUMN active TINYINT(1) DEFAULT 1 AFTER role');
        console.log('✅ Spalte "active" erfolgreich hinzugefügt.');
    } catch (e) {
        if (e.code === 'ER_DUP_COLUMN_NAME') {
            console.log('ℹ️ Spalte "active" existiert bereits.');
        } else {
            console.error('❌ Fehler bei der Migration:', e.message);
        }
    } finally {
        await connection.end();
    }
}

migrate();
