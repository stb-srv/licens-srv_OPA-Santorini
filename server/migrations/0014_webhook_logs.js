export default async function (db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS webhook_logs (
            id CHAR(36) NOT NULL PRIMARY KEY,
            webhook_url VARCHAR(512) NOT NULL,
            event VARCHAR(128) NOT NULL,
            status ENUM('success', 'failed') NOT NULL,
            error_message TEXT DEFAULT NULL,
            attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_attempted_at (attempted_at),
            INDEX idx_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
}
