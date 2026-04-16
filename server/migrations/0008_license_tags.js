/**
 * 0008_license_tags.js
 * Fügt das Tags-Feld zur licenses-Tabelle hinzu.
 */
export default async function (conn) {
    const [[{ n: hasTagsCol }]] = await conn.query(`
        SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'licenses' AND COLUMN_NAME = 'tags'
    `);

    if (!hasTagsCol) {
        await conn.query(`
            ALTER TABLE licenses
            ADD COLUMN tags JSON NOT NULL DEFAULT ('[]')
            COMMENT 'Tags zur Gruppierung von Lizenzen (z.B. Region, Reseller)'
        `);
        console.log('  ✅ licenses: Tags-Spalte hinzugefügt.');
    }
}
