import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schemas/*.schema.ts',
  out: './src/migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 
      'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db',
  },
  // Migration table lives in public schema — not in our isolated schemas
  migrations: {
    table: 'drizzle_migrations',
    schema: 'public',
  },
  verbose: true,
  strict: true,
});
