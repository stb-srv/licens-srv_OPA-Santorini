export async function up(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS reseller_keys (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            api_key      VARCHAR(64) NOT NULL UNIQUE,
            name         VARCHAR(100) NOT NULL,
            email        VARCHAR(150),
            max_trials   INT NOT NULL DEFAULT 10,
            used_trials  INT NOT NULL DEFAULT 0,
            active       TINYINT(1) NOT NULL DEFAULT 1,
            created_at   DATETIME DEFAULT NOW(),
            notes        TEXT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    
    // foreign key explizit benennen für den down-vorgang
    await db.query(`
        ALTER TABLE licenses
        ADD COLUMN IF NOT EXISTS reseller_id INT NULL,
        ADD CONSTRAINT licenses_ibfk_reseller 
            FOREIGN KEY IF NOT EXISTS (reseller_id) 
            REFERENCES reseller_keys(id) ON DELETE SET NULL
    `);
}

export async function down(db) {
    await db.query('ALTER TABLE licenses DROP FOREIGN KEY IF EXISTS licenses_ibfk_reseller');
    await db.query('ALTER TABLE licenses DROP COLUMN IF EXISTS reseller_id');
    await db.query('DROP TABLE IF EXISTS reseller_keys');
}
