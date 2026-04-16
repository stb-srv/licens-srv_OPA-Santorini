// Migration 0002b: v2.1 fixes – MySQL 5.7 compatible (uses INFORMATION_SCHEMA checks)

async function columnExists(connection, table, column) {
    const [rows] = await connection.query(
        `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    return rows[0].cnt > 0;
}

async function tableExists(connection, table) {
    const [rows] = await connection.query(
        `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table]
    );
    return rows[0].cnt > 0;
}

async function indexExists(connection, table, indexName) {
    const [rows] = await connection.query(
        `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [table, indexName]
    );
    return rows[0].cnt > 0;
}

export default async function (connection) {
    // 1. purchase_history
    if (!(await tableExists(connection, 'purchase_history'))) {
        await connection.query(`
            CREATE TABLE purchase_history (
                id CHAR(36) NOT NULL PRIMARY KEY,
                customer_id CHAR(36),
                license_key VARCHAR(64),
                plan VARCHAR(32),
                action ENUM('purchase','renewal','upgrade','downgrade','cancellation') DEFAULT 'purchase',
                amount DECIMAL(10,2),
                note TEXT,
                created_by VARCHAR(64),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_customer (customer_id),
                INDEX idx_license (license_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
    }

    // 2. customer_sessions
    if (!(await tableExists(connection, 'customer_sessions'))) {
        await connection.query(`
            CREATE TABLE customer_sessions (
                id CHAR(36) NOT NULL PRIMARY KEY,
                customer_id CHAR(36) NOT NULL,
                token_hash VARCHAR(64) NOT NULL UNIQUE,
                ip VARCHAR(64),
                user_agent VARCHAR(512),
                revoked TINYINT(1) DEFAULT 0,
                expires_at DATETIME NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_token_hash (token_hash),
                INDEX idx_customer (customer_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
    }

    // 3. customers – fehlende Spalten
    const customerColumns = [
        ['archived',              'TINYINT(1) DEFAULT 0'],
        ['password_hash',         'VARCHAR(255)'],
        ['must_change_password',  'TINYINT(1) DEFAULT 0'],
        ['portal_token',          'VARCHAR(80)'],
        ['portal_token_expires',  'DATETIME'],
        ['contact_person',        'VARCHAR(255)'],
        ['portal_username',       'VARCHAR(64)'],
    ];
    for (const [col, def] of customerColumns) {
        if (!(await columnExists(connection, 'customers', col))) {
            await connection.query(`ALTER TABLE customers ADD COLUMN ${col} ${def}`);
        }
    }

    // Index für portal_username
    if (!(await indexExists(connection, 'customers', 'idx_portal_username'))) {
        await connection.query(`CREATE INDEX idx_portal_username ON customers (portal_username)`);
    }

    // 4. licenses – ENUM status
    await connection.query(`
        ALTER TABLE licenses
            MODIFY COLUMN status ENUM('active','suspended','revoked','expired','cancelled') NOT NULL DEFAULT 'active'
    `);

    // 5. licenses – ENUM type
    await connection.query(`
        ALTER TABLE licenses
            MODIFY COLUMN type ENUM('FREE','BASIC','STARTER','PRO','PRO_PLUS','ENTERPRISE') NOT NULL DEFAULT 'FREE'
    `);

    // 6. licenses – validated_domains
    if (!(await columnExists(connection, 'licenses', 'validated_domains'))) {
        await connection.query(`ALTER TABLE licenses ADD COLUMN validated_domains JSON`);
    }
}
