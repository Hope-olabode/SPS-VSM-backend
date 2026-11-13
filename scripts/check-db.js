import mysql from "mysql2/promise";

try {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  const [[row]] = await conn.query("SELECT VERSION() AS version, DATABASE() AS db");
  console.log(`Connected. MySQL ${row.version}, database "${row.db}"`);
  await conn.end();
} catch (err) {
  console.error(`Connection failed: ${err.code} - ${err.message}`);
  process.exitCode = 1;
}