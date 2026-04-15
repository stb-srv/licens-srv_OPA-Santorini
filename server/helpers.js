import crypto from 'crypto';
import db from './db.js';

export const generateKey = (type) => {
    const prefix = {
        FREE: 'OPA-FREE',
        STARTER: 'OPA-START',
        PRO: 'OPA-PRO',
        PRO_PLUS: 'OPA-PROPLUS',
        ENTERPRISE: 'OPA-ENT'
    }[type] || 'OPA-UNKNOWN';
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}-${rand}-${new Date().getFullYear()}`;
};

export const domainMatches = (pattern, domain) => {
    if (!pattern || pattern === '*') return true;
    if (!domain) return true;
    const cleanDomain = domain
        .replace(/^https?:\/\//, '')
        .replace(/:\d+$/, '')
        .split('/')[0];
    if (pattern === cleanDomain) return true;
    if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(2);
        return cleanDomain === suffix || cleanDomain.endsWith('.' + suffix);
    }
    return false;
};

export const getClientIp = (req) =>
    req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';

// Erkennt beim ersten Aufruf welche Spalten audit_log hat (data vs details, ts vs created_at)
let _auditCols = null;
async function detectAuditCols() {
    if (_auditCols) return _auditCols;
    try {
        const [cols] = await db.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_log'`
        );
        const names = cols.map(c => c.COLUMN_NAME);
        _auditCols = {
            dataCol:  names.includes('details') ? 'details' : 'data',
            tsCol:    names.includes('created_at') ? 'created_at' : 'ts'
        };
        console.log(`ℹ️  audit_log Schema erkannt: dataCol=${_auditCols.dataCol}, tsCol=${_auditCols.tsCol}`);
    } catch {
        _auditCols = { dataCol: 'data', tsCol: 'ts' };
    }
    return _auditCols;
}

export const addAuditLog = async (action, details, actor = 'system') => {
    try {
        const { dataCol, tsCol } = await detectAuditCols();
        await db.query(
            `INSERT INTO audit_log (id, actor, action, \`${dataCol}\`, \`${tsCol}\`) VALUES (?, ?, ?, ?, NOW())`,
            [crypto.randomUUID(), actor, action, JSON.stringify(details)]
        );
    } catch (e) {
        console.error('Audit-Log Fehler:', e.message);
    }
};

export const parseJsonField = (value, fallback = {}) => {
    if (!value) return fallback;
    try { return typeof value === 'string' ? JSON.parse(value) : value; }
    catch { return fallback; }
};

/**
 * asyncHandler: Wrapper für Express-Routen, um try/catch-Boilerplate zu vermeiden.
 * Leitet Fehler automatisch an den globalen Error-Handler weiter.
 */
export const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
