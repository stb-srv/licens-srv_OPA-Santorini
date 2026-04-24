/**
 * Debug-Script: Prüft den Admin-Account in der Datenbank.
 * Aufruf: node debug-admin.js [username] [password]
 * 
 * Ohne Argumente: Zeigt alle Admin-Accounts an.
 * Mit username + password: Testet den Login.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
});

console.log('✅ DB-Verbindung hergestellt.\n');

// Alle Admins anzeigen
const [admins] = await conn.query('SELECT id, username, role, active, LEFT(password_hash, 20) AS hash_preview, two_factor_enabled, created_at FROM admins');
console.log('📋 Vorhandene Admin-Accounts:');
console.table(admins);

if (admins.length === 0) {
    console.error('\n❌ PROBLEM: Keine Admin-Accounts in der Datenbank!');
    console.log('   Lösung: Führe "node setup-db.js" aus oder erstelle manuell einen Account.');
    await conn.end();
    process.exit(1);
}

// admin_sessions Tabelle prüfen
try {
    const [sessions] = await conn.query('SELECT COUNT(*) AS count FROM admin_sessions');
    console.log(`\n📦 admin_sessions Tabelle existiert (${sessions[0].count} Einträge)`);
} catch (e) {
    console.error('\n⚠️  admin_sessions Tabelle fehlt! Migrationen ausführen.');
}

// Login testen wenn Argumente übergeben
const testUser = process.argv[2];
const testPass = process.argv[3];

if (testUser && testPass) {
    console.log(`\n🔐 Teste Login für: "${testUser}"...`);
    
    const [rows] = await conn.query(
        'SELECT id, username, password_hash, role, active FROM admins WHERE username = ?',
        [testUser]
    );
    
    if (!rows[0]) {
        console.error(`❌ Benutzer "${testUser}" nicht gefunden!`);
        console.log('   Vorhandene Benutzernamen:', admins.map(a => a.username).join(', '));
    } else {
        const admin = rows[0];
        console.log(`   Benutzer gefunden: ID=${admin.id}, Rolle=${admin.role}, Aktiv=${admin.active}`);
        console.log(`   Hash (erste 30 Zeichen): ${admin.password_hash.slice(0, 30)}...`);
        console.log(`   Hash-Länge: ${admin.password_hash.length} (erwartet: 60 für bcrypt)`);
        
        // Prüfe ob es ein gültiger bcrypt-Hash ist
        if (!admin.password_hash.startsWith('$2a$') && !admin.password_hash.startsWith('$2b$') && !admin.password_hash.startsWith('$2y$')) {
            console.error(`❌ PROBLEM: password_hash ist kein gültiger bcrypt-Hash!`);
            console.log(`   Gefunden: "${admin.password_hash.slice(0, 10)}..."`);
            console.log(`   Erwartet: "$2a$12$..." oder "$2b$12$..."`);
        } else {
            const match = await bcrypt.compare(testPass, admin.password_hash);
            if (match) {
                console.log('   ✅ Passwort ist KORREKT!');
                console.log('\n   → Wenn der Login trotzdem fehlschlägt, prüfe:');
                console.log('     1. CORS-Konfiguration (CORS_ORIGINS in .env)');
                console.log('     2. Rate-Limiting (loginLimiter: max 10/15min)');
                console.log('     3. RSA-Keys (RSA_PRIVATE_KEY / RSA_PUBLIC_KEY)');
            } else {
                console.error('   ❌ Passwort ist FALSCH!');
                console.log('\n   → Neues Passwort setzen mit:');
                console.log(`     node -e "import bcrypt from 'bcryptjs'; bcrypt.hash('DEIN_NEUES_PASSWORT', 12).then(h => console.log(h))"`);
                console.log(`     Dann in DB: UPDATE admins SET password_hash = 'HASH' WHERE username = '${testUser}';`);
            }
        }
    }
} else {
    console.log('\n💡 Tipp: Teste einen Login mit:');
    console.log('   node debug-admin.js <benutzername> <passwort>');
}

await conn.end();
