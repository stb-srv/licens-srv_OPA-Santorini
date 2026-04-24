/**
 * Migration 0010 – Trial Support
 * Fixes:
 *  - TRIAL zum licenses.type ENUM hinzufügen
 *  - cancelled zum licenses.status ENUM hinzufügen
 *  - notes TEXT Spalte hinzufügen
 *  - expiry_notified_at DATETIME Spalte hinzufügen
 */
import db from '../db.js';

export async function up() {
    console.log('⏫ Migration 0010: Trial-Support Schema-Fixes …');

    // 1. TRIAL zum type ENUM
    await db.query(`
        ALTER TABLE licenses
        MODIFY COLUMN type
          ENUM('FREE','STARTER','PRO','PRO_PLUS','ENTERPRISE','TRIAL')
          NOT NULL DEFAULT 'FREE'
    `);
    console.log('  ✅ licenses.type ENUM erweitert um TRIAL');

    // 2. cancelled zum status ENUM
    await db.query(`
        ALTER TABLE licenses
        MODIFY COLUMN status
          ENUM('active','suspended','revoked','expired','cancelled')
          NOT NULL DEFAULT 'active'
    `);
    console.log('  ✅ licenses.status ENUM erweitert um cancelled');

    // 3. notes Spalte (falls nicht vorhanden)
    const [notesCol] = await db.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'licenses' AND COLUMN_NAME = 'notes'
    `);
    if (notesCol.length === 0) {
        await db.query(`ALTER TABLE licenses ADD COLUMN notes TEXT DEFAULT NULL`);
        console.log('  ✅ licenses.notes Spalte hinzugefügt');
    } else {
        console.log('  ⏭  licenses.notes bereits vorhanden');
    }

    // 4. expiry_notified_at Spalte (falls nicht vorhanden)
    const [expCol] = await db.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'licenses' AND COLUMN_NAME = 'expiry_notified_at'
    `);
    if (expCol.length === 0) {
        await db.query(`ALTER TABLE licenses ADD COLUMN expiry_notified_at DATETIME DEFAULT NULL`);
        console.log('  ✅ licenses.expiry_notified_at Spalte hinzugefügt');
    } else {
        console.log('  ⏭  licenses.expiry_notified_at bereits vorhanden');
    }

    console.log('✅ Migration 0010 abgeschlossen.');
}
