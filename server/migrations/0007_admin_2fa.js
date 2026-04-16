/**
 * 0007_admin_2fa.js
 * Fügt Spalten für 2FA (TOTP) zur admins-Tabelle hinzu.
 */
export default async function (conn) {
    const [[{ n: has2faSecret }]] = await conn.query(`
        SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admins' AND COLUMN_NAME = 'two_factor_secret'
    `);

    if (!has2faSecret) {
        await conn.query(`
            ALTER TABLE admins
            ADD COLUMN two_factor_secret  VARCHAR(128) DEFAULT NULL,
            ADD COLUMN two_factor_enabled TINYINT(1)   DEFAULT 0
        `);
        console.log('  ✅ admins: Spalten für 2FA hinzugefügt.');
    }
}
