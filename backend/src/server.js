const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { connectMySQL } = require("./db/mysql");

const authRoutes = require("./routes/auth");
const goldRoutes = require("./routes/gold");
const itemsRoutes = require("./routes/items");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = [
  "http://localhost:5173",
  "https://gold-tracker-psi.vercel.app",
  process.env.CORS_ORIGIN,
].filter(Boolean);

console.log("CORS_ORIGIN env:", process.env.CORS_ORIGIN);
console.log("Allowed origins:", allowedOrigins);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      console.log("Blocked by CORS:", origin);
      return callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.options("*", cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api/auth", authRoutes);
app.use("/api/gold", goldRoutes);
app.use("/api/items", itemsRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

async function start() {
  try {
    console.log("MYSQL_HOST:", process.env.MYSQL_HOST);
    console.log("MYSQL_PORT:", process.env.MYSQL_PORT);
    console.log("MYSQL_DATABASE:", process.env.MYSQL_DATABASE);
    console.log("MYSQL_USER:", process.env.MYSQL_USER);

    await connectMySQL();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
}

start();