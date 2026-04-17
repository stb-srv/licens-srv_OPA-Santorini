import mysql from 'mysql2/promise';

const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'opa_licenses',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '+00:00',
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
});

export async function testConnection() {
    const conn = await db.getConnection();
    conn.release();
    console.log('✅  MySQL Verbindung erfolgreich –', (process.env.DB_HOST || '127.0.0.1') + ':' + (process.env.DB_PORT || 3306));
}

export default db;
