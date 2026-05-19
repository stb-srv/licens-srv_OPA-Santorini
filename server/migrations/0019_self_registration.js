/**
 * Migration 0019 – Self Registration
 * Adds verified, email_verify_token, and email_verify_expires columns to customers table.
 * Sets verified = 1 for existing customers.
 */

export async function up(db) {
    console.log('⏫ Migration 0019: Adding self registration columns to customers table...');

    const columnsToEnsure = [
        { name: 'verified', type: 'TINYINT(1) NOT NULL DEFAULT 0' },
        { name: 'email_verify_token', type: 'VARCHAR(64) DEFAULT NULL' },
        { name: 'email_verify_expires', type: 'DATETIME DEFAULT NULL' }
    ];

    for (const col of columnsToEnsure) {
        const [[{ n: colExists }]] = await db.query(`
            SELECT COUNT(*) AS n FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = ?
        `, [col.name]);

        if (!colExists) {
            await db.query(`ALTER TABLE customers ADD COLUMN ${col.name} ${col.type}`);
            console.log(`  ✅ Column customers.${col.name} added.`);
        } else {
            console.log(`  ⏭  Column customers.${col.name} already exists.`);
        }
    }

    // Set verified = 1 for existing customers created before now
    const [result] = await db.query(`
        UPDATE customers 
        SET verified = 1 
        WHERE verified = 0 AND (created_at IS NULL OR created_at < NOW())
    `);
    console.log(`  ✅ Verified status set to 1 for existing customers (affected: ${result.affectedRows || 0}).`);

    console.log('✅ Migration 0019 up completed.');
}

export async function down(db) {
    console.log('⏬ Migration 0019: Reverting self registration columns...');

    const columnsToDrop = ['verified', 'email_verify_token', 'email_verify_expires'];
    for (const col of columnsToDrop) {
        const [[{ n: colExists }]] = await db.query(`
            SELECT COUNT(*) AS n FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = ?
        `, [col]);

        if (colExists) {
            await db.query(`ALTER TABLE customers DROP COLUMN ${col}`);
            console.log(`  ✅ Column customers.${col} dropped.`);
        }
    }

    console.log('✅ Migration 0019 down completed.');
}

export default up;
