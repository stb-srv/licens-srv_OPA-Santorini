import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-production';

export const requireAuth = (req, res, next) => {
    const token = req.headers['authorization']?.startsWith('Bearer ')
        ? req.headers['authorization'].slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'No token provided' });
    try {
        req.admin = jwt.verify(token, ADMIN_SECRET);
        next();
    } catch {
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
};

export const requireSuperAdmin = (req, res, next) => {
    if (req.admin?.role !== 'superadmin')
        return res.status(403).json({ success: false, message: 'Superadmin required' });
    next();
};

export const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 10,
    message: { success: false, message: 'Too many login attempts. Please wait 15 minutes.' }
});

export const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

export const validateLimiter = rateLimit({
    windowMs: 60 * 1000, max: 30,
    message: { status: 'rate_limited', message: 'Too many validation requests.' }
});

export const setupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 5,
    message: { success: false, message: 'Too many setup attempts.' }
});
