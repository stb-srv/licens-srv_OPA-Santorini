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

export const addAuditLog = async (action, details, actor = 'system') => {
    try {
        await db.query(
            'INSERT INTO audit_log (id, actor, action, details) VALUES (?, ?, ?, ?)',
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
