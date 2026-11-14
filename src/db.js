import mysql from "mysql2/promise";

// One shared pool for the whole app. Always pass values as `?` parameters (never build SQL by joining strings).
export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: true },
  connectionLimit: 10,
  dateStrings: false,
});

/** query("SELECT * FROM users WHERE email = ?", [email]) -> array of rows */
export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** like query() but returns the first row or null */
export async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}
