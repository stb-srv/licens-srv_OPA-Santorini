export default async function (db) {
    await db.query(`
        ALTER TABLE licenses 
        ADD COLUMN expiry_notified_7d_at DATETIME DEFAULT NULL 
        AFTER expiry_notified_at
    `);
}
