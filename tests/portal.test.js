import request from 'supertest';
import { app } from '../server.js';
import db from '../server/db.js';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

const PORTAL_SECRET = 'portal-secure-test-secret';
// Inject secret for test
process.env.PORTAL_SECRET = PORTAL_SECRET;

describe('Customer Portal API', () => {
    let portalToken;

    beforeAll(() => {
        portalToken = jwt.sign({ customer_id: 'cust1', type: 'portal' }, PORTAL_SECRET);
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('GET /api/portal/me should require login', async () => {
        const res = await request(app).get('/api/portal/me');
        expect(res.statusCode).toBe(401);
    });

    test('GET /api/portal/me should return customer data when logged in', async () => {
        const mockDb = jest.spyOn(db, 'query').mockImplementation((sql, params) => {
            if (sql.includes('FROM customer_sessions')) {
                return Promise.resolve([[{ id: 'sess1' }], []]);
            }
            if (sql.includes('FROM customers WHERE id = ?')) {
                return Promise.resolve([[{ id: 'cust1', name: 'Max Mustermann', email: 'max@test.de', must_change_password: 0 }], []]);
            }
            return Promise.resolve([[], []]);
        });

        const res = await request(app)
            .get('/api/portal/me')
            .set('Authorization', `Bearer ${portalToken}`);

        expect(res.statusCode).toBe(200);
        expect(res.body.customer.name).toBe('Max Mustermann');
        
        mockDb.mockRestore();
    });

    test('PATCH /api/portal/licenses/:key/domain should validate domain format', async () => {
        jest.spyOn(db, 'query').mockImplementation((sql, params) => {
             if (sql.includes('FROM customer_sessions')) return Promise.resolve([[{ id: 's1' }], []]);
             if (sql.includes('FROM customers')) return Promise.resolve([[{ id: 'cust1' }], []]);
             return Promise.resolve([[], []]);
        });

        const res = await request(app)
            .patch('/api/portal/licenses/KEY123/domain')
            .set('Authorization', `Bearer ${portalToken}`)
            .send({ domain: 'invalid domain' });

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toContain('Ungültige Domain');
    });

    test('PATCH /api/portal/update-profile should validate billing fields', async () => {
        jest.spyOn(db, 'query').mockImplementation((sql, params) => {
             if (sql.includes('FROM customer_sessions')) return Promise.resolve([[{ id: 's1' }], []]);
             if (sql.includes('FROM customers')) return Promise.resolve([[{ id: 'cust1' }], []]);
             return Promise.resolve([[], []]);
        });

        // 1. Invalid zip code (letters/numbers only, max 10 chars)
        let res = await request(app)
            .patch('/api/portal/update-profile')
            .set('Authorization', `Bearer ${portalToken}`)
            .send({ billing_zip: '12345-67890' });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toContain('Postleitzahl ist ungültig');

        // 2. Invalid country code (2-letter ISO only)
        res = await request(app)
            .patch('/api/portal/update-profile')
            .set('Authorization', `Bearer ${portalToken}`)
            .send({ billing_country: 'GER' });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toContain('Ungültiges Land');
    });

    test('PATCH /api/portal/update-profile should update billing fields when valid', async () => {
        const mockDb = jest.spyOn(db, 'query').mockImplementation((sql, params) => {
             if (sql.includes('FROM customer_sessions')) return Promise.resolve([[{ id: 's1' }], []]);
             if (sql.includes('FROM customers WHERE id = ?')) {
                 return Promise.resolve([[{ 
                     id: 'cust1', name: 'Max', email: 'max@test.de', 
                     billing_street: 'Hauptstr. 1', billing_city: 'Berlin', 
                     billing_zip: '10115', billing_country: 'DE', tax_id: 'DE123456789'
                 }], []]);
             }
             return Promise.resolve([[], []]);
        });

        const res = await request(app)
            .patch('/api/portal/update-profile')
            .set('Authorization', `Bearer ${portalToken}`)
            .send({ 
                billing_street: 'Hauptstr. 1', 
                billing_city: 'Berlin', 
                billing_zip: '10115', 
                billing_country: 'de', 
                tax_id: 'DE123456789' 
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.customer.billing_street).toBe('Hauptstr. 1');
        expect(res.body.customer.billing_zip).toBe('10115');
        expect(res.body.customer.billing_country).toBe('DE'); // converted to uppercase
        expect(res.body.customer.tax_id).toBe('DE123456789');

        mockDb.mockRestore();
    });
});
