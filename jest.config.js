process.env.DB_HOST = 'localhost';
process.env.DB_USER = 'root';
process.env.DB_PASS = 'test';
process.env.DB_NAME = 'test';
process.env.ADMIN_SECRET = 'secure-test-secret';
process.env.PORTAL_SECRET = 'portal-secure-test-secret';
process.env.HMAC_SECRET = 'hmac-secure-test-secret-long-enough-for-validation';

export default {
  testEnvironment: 'node',
  transform: {},
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
