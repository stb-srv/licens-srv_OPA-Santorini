export const up = async (db) => {
    await db.query(`
        ALTER TABLE licenses
            ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT NULL,
            ADD COLUMN IF NOT EXISTS instance_id VARCHAR(255) DEFAULT NULL,
            ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255) DEFAULT NULL,
            ADD COLUMN IF NOT EXISTS restaurant_name VARCHAR(255) DEFAULT NULL
    `);
};

export const down = async (db) => {
    await db.query(`
        ALTER TABLE licenses
            DROP COLUMN IF EXISTS notes,
            DROP COLUMN IF EXISTS instance_id,
            DROP COLUMN IF EXISTS contact_email,
            DROP COLUMN IF EXISTS restaurant_name
    `);
};
