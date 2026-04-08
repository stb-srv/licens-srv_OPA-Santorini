// Run this script once to create the initial admin user:
// node setup-admin.js
import { readFile, writeFile } from 'fs/promises';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'db.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

const run = async () => {
    const username = await ask('Admin username: ');
    const password = await ask('Admin password: ');
    rl.close();

    if (!username || !password || password.length < 8) {
        console.error('❌ Password must be at least 8 characters.');
        process.exit(1);
    }

    const hash = await bcrypt.hash(password, 12);
    const db = JSON.parse(await readFile(DB_PATH, 'utf-8'));

    if (!db.admins) db.admins = [];
    const existing = db.admins.findIndex(a => a.username === username);
    const adminEntry = { username, password_hash: hash, role: 'admin', created_at: new Date().toISOString() };

    if (existing > -1) {
        db.admins[existing] = adminEntry;
        console.log(`✅ Admin "${username}" updated.`);
    } else {
        db.admins.push(adminEntry);
        console.log(`✅ Admin "${username}" created.`);
    }

    await writeFile(DB_PATH, JSON.stringify(db, null, 2));
    console.log('🔒 Done! You can now login at /api/admin/login');
};

run().catch(e => { console.error(e); process.exit(1); });
