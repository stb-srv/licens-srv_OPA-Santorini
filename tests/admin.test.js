import request from 'supertest';
import { app } from '../server.js';
import db from '../server/db.js';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const ADMIN_SECRET = 'secure-test-secret';

describe('Admin API', () => {
    let adminToken;

    beforeAll(() => {
        // Create a valid token for tests
        adminToken = jwt.sign({ username: 'testadmin', role: 'superadmin' }, ADMIN_SECRET);
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('POST /api/admin/login should work with correct credentials', async () => {
        const passwordHash = await bcrypt.hash('password123', 12);
        
        // Mock DB for login
        const mockQuery = jest.spyOn(db, 'query').mockImplementation((sql, params) => {
            if (sql.includes('FROM admins WHERE username = ?')) {
                return Promise.resolve([[{ 
                    id: 1, 
                    username: 'testadmin', 
                    password_hash: passwordHash, 
                    role: 'superadmin',
                    two_factor_enabled: 0
                }], []]);
            }
            if (sql.includes('INSERT INTO admin_sessions')) {
                return Promise.resolve([{ affectedRows: 1 }, []]);
            }
            if (sql.includes('INSERT INTO audit_log')) {
                return Promise.resolve([{ affectedRows: 1 }, []]);
            }
            return Promise.resolve([[], []]);
        });

        const res = await request(app)
            .post('/api/admin/login')
            .send({ username: 'testadmin', password: 'password123' });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body).toHaveProperty('token');
        
        mockQuery.mockRestore();
    });

    test('GET /api/admin/licenses should require authentication', async () => {
        const res = await request(app).get('/api/admin/licenses');
        expect(res.statusCode).toBe(401);
    });

    test('GET /api/admin/licenses should work with valid token', async () => {
        // Mock DB for session check and license list
        const mockDb = jest.spyOn(db, 'query').mockImplementation((sql, params) => {
            // console.log('SQL:', sql); // Debug
            if (sql.includes('FROM admin_sessions')) {
                return Promise.resolve([[{ id: 'sess1' }], []]);
            }
            if (sql.includes('COUNT(*)')) {
                return Promise.resolve([[{ total: 1 }], []]);
            }
            if (sql.includes('SELECT * FROM licenses')) {
                return Promise.resolve([[{ license_key: 'TEST-KEY', type: 'PRO' }], []]);
            }
            return Promise.resolve([[], []]);
        });

        const res = await request(app)
            .get('/api/admin/licenses')
            .set('Authorization', `Bearer ${adminToken}`);

        if (res.statusCode !== 200) {
            console.error('Admin Licenses Error:', res.body);
        }

        expect(res.statusCode).toBe(200);
        expect(res.body.licenses).toBeDefined();
        expect(res.body.licenses[0].license_key).toBe('TEST-KEY');

        mockDb.mockRestore();
    });
});
