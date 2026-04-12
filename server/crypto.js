import jwt from 'jsonwebtoken';
import crypto from 'crypto';

export const RSA_PRIVATE_KEY = process.env.RSA_PRIVATE_KEY
    ? process.env.RSA_PRIVATE_KEY.replace(/\\n/g, '\n')
    : null;

export const RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAutES8Xqif1PpLJU9ClMJ
rGfeCoUVOOni5/WiwGFdTd5ygYyie22fBheBA2fRek6xXDfGtC/QdIg7zbqI/0eQ
V7DCcytIGJSfPRNW4t6cb7oRUVTbo74jia5GUDyJNLJPQDsPVWDvi6rpB+/hv+Uh
rL3UQbHYwoJi/H5R2uwPsd9JaznGoygWhmaWpueXQkxYMRlupUWD1hT+OBSYWBnI
l7NUVsJ8pDOE2u9REwVgBnJEbdA39YnZ2NB4W/5JZPLsM8pkp1QO32THcHixFUvC
N+xMcoOA3fRdAICdI6kI9LccR4hzr7Btf/8Wbk0erF48Xw5NjFj0CZcRIjegiq2m
HQIDAQAB
-----END PUBLIC KEY-----`;

// HMAC_SECRET: nur intern in diesem Modul verwendet – kein Export nach außen
const HMAC_SECRET = process.env.HMAC_SECRET || 'hmac-change-me-in-production';

// Token-Laufzeit: 72h statt 25h – verhindert FREE-Fallback bei Server-Neustart
// da der LicenseChecker erst nach 5min + alle 24h prüft
export const createSignedLicenseToken = (payload, expiresIn = '72h') => {
    if (!RSA_PRIVATE_KEY) return null;
    return jwt.sign(payload, RSA_PRIVATE_KEY, { algorithm: 'RS256', expiresIn });
};

export const signResponse = (payload) => {
    const data = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', HMAC_SECRET).update(data).digest('hex');
    return { ...payload, _sig: sig, _ts: Date.now() };
};

export const isHmacActive = () => HMAC_SECRET !== 'hmac-change-me-in-production';

// Nur für interne Nutzung in public.js (Offline-Token Signing)
export { HMAC_SECRET };
