import './env.js';
import { createPool } from 'mysql2/promise';

const pool = createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'test',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export async function q(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

export { pool };