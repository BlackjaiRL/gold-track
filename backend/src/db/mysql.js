const mysql = require("mysql2/promise");

let pool;

async function connectMySQL(retries = 15, delay = 3000) {
  while (retries > 0) {
    let conn;

    try {
      console.log("Connecting to MySQL...");

      if (!pool) {
        pool = mysql.createPool({
          host: process.env.MYSQL_HOST,
          port: Number(process.env.MYSQL_PORT || 3306),
          user: process.env.MYSQL_USER,
          password: process.env.MYSQL_PASSWORD,
          database: process.env.MYSQL_DATABASE,
          waitForConnections: true,
          connectionLimit: 10,
          queueLimit: 0,
          connectTimeout: 10000,
        });
      }

      conn = await pool.getConnection();
      await conn.query("SELECT 1");

      console.log("✅ Connected to MySQL");

      await createTables();

      return;
    } catch (err) {
      console.error(`❌ DB not ready: ${err.message}`);
      retries -= 1;

      if (retries === 0) {
        throw new Error(`❌ Could not connect to MySQL: ${err.message}`);
      }

      await new Promise((res) => setTimeout(res, delay));
    } finally {
      if (conn) conn.release();
    }
  }
}

async function createTables() {
  const pool = getPool();

  console.log("📦 Creating tables if not exist...");

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
      CONSTRAINT fk_gold_items_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
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
  connectMySQL,
  getPool,
};
