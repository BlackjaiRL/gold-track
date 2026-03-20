const mysql = require("mysql2/promise");

let pool;

async function connectMariaDB(retries = 10) {
  while (retries) {
    try {
      console.log("Connecting to MariaDB...");

      pool = mysql.createPool({
        host: process.env.MARIADB_HOST,
        port: Number(process.env.MARIADB_PORT || 3306),
        user: process.env.MARIADB_USER,
        password: process.env.MARIADB_PASSWORD,
        database: process.env.MARIADB_DATABASE,
        waitForConnections: true,
        connectionLimit: 10,
      });

      const conn = await pool.getConnection();
      console.log("✅ Connected to MariaDB");
      conn.release();

      // 👉 Create tables after connection
      await createTables();

      return;
    } catch (err) {
      console.log(`❌ DB not ready... retrying (${retries})`);
      retries -= 1;
      await new Promise((res) => setTimeout(res, 3000));
    }
  }

  throw new Error("❌ Could not connect to MariaDB");
}

async function createTables() {
  const pool = getPool();

  console.log("📦 Creating tables if not exist...");

  // USERS TABLE
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NULL,
      google_sub VARCHAR(255) NULL UNIQUE,
      name VARCHAR(255) NULL,
      picture_url TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // GOLD ITEMS TABLE
  await pool.query(`
  CREATE TABLE IF NOT EXISTS gold_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    image_path TEXT NOT NULL,
    grams DECIMAL(10,2) NOT NULL,
    buy_price_total DECIMAL(12,2) NOT NULL DEFAULT 0,
    price_per_gram_usd DECIMAL(10,4) NOT NULL,
    estimated_value_usd DECIMAL(12,2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);
  await pool.query(`
  ALTER TABLE gold_items
  ADD COLUMN IF NOT EXISTS buy_price_total DECIMAL(12,2) NOT NULL DEFAULT 0
`);

  console.log("✅ Tables ready");
}

function getPool() {
  if (!pool) {
    throw new Error("DB not initialized");
  }
  return pool;
}

module.exports = {
  connectMariaDB,
  getPool,
};
