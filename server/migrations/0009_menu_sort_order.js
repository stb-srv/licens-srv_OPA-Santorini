/**
 * 0009_menu_sort_order.js
 * Ergänzt die sort_order Spalte in der menu Tabelle falls fehlend.
 * Stellt außerdem sicher, dass die menu Tabelle existiert.
 */
export default async function (conn) {
    // 1. menu Tabelle sicherstellen
    await conn.query(`
        CREATE TABLE IF NOT EXISTS menu (
            id INT AUTO_INCREMENT PRIMARY KEY,
            license_key VARCHAR(64),
            category VARCHAR(64),
            name VARCHAR(255) NOT NULL,
            description TEXT,
            price DECIMAL(10,2),
            sort_order INT DEFAULT 0,
            active TINYINT(1) DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (license_key) REFERENCES licenses(license_key) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 2. sort_order Spalte prüfen und ggf. hinzufügen
    const [[{ n: hasSortOrder }]] = await conn.query(`
        SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu' AND COLUMN_NAME = 'sort_order'
    `);

    if (!hasSortOrder) {
        await conn.query(`ALTER TABLE menu ADD COLUMN sort_order INT DEFAULT 0 AFTER price`);
        console.log('  ✅ menu.sort_order hinzugefügt');
    }
}
