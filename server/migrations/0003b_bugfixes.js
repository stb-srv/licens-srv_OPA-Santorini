async function columnExists(connection, table, column) {
    const [rows] = await connection.query(
        `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    return rows[0].cnt > 0;
}

export default async function (connection) {
    // Fix #3: expiry_notified_at
    if (!(await columnExists(connection, 'licenses', 'expiry_notified_at'))) {
        await connection.query(`
            ALTER TABLE licenses
              ADD COLUMN expiry_notified_at DATETIME NULL DEFAULT NULL
              COMMENT 'Zeitpunkt der letzten Ablauf-Benachrichtigung. NULL = noch nicht benachrichtigt.'
        `);
    }

    // Fix #2: must_change_password
    if (!(await columnExists(connection, 'customers', 'must_change_password'))) {
        await connection.query(`
            ALTER TABLE customers
              ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0
              COMMENT '1 = Kunde muss Passwort beim naechsten Login aendern.'
        `);
    }
}
