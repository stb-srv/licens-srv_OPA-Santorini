export async function up(db) {
    // Heartbeat-Tabelle (angepasst an license_key PK)
    await db.query(`
        CREATE TABLE IF NOT EXISTS license_heartbeats (
            license_key  VARCHAR(64) NOT NULL,
            ip           VARCHAR(45),
            user_agent   VARCHAR(200),
            ts           DATETIME NOT NULL,
            PRIMARY KEY (license_key),
            FOREIGN KEY (license_key) REFERENCES licenses(license_key) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Multi-Instance: Spalten in licenses
    await db.query(`
        ALTER TABLE licenses
        ADD COLUMN IF NOT EXISTS max_instances TINYINT UNSIGNED NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS instance_count TINYINT UNSIGNED NOT NULL DEFAULT 1
    `);
}

export async function down(db) {
    await db.query('DROP TABLE IF EXISTS license_heartbeats');
    await db.query('ALTER TABLE licenses DROP COLUMN IF EXISTS max_instances, DROP COLUMN IF EXISTS instance_count');
}
