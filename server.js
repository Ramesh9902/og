const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { pool, testConnection } = require("./db");
const { downloadMedia, getMediaInfo, validateSupportedUrl, ValidationError, MAX_URL_LENGTH } = require("./services/downloadService");
const {
  SESSION_COOKIE_NAME,
  AuthValidationError,
  validateRegistrationInput,
  validateLoginInput,
  hashPassword,
  verifyPassword,
  createSessionToken,
  hashSessionToken,
  createSessionExpiryDate,
  parseCookies,
  buildSessionCookie,
  buildClearSessionCookie
} = require("./services/authService");

const app = express();
const port = Number(process.env.PORT || 4000);
const projectRoot = __dirname;
const downloadDirectoryName = process.env.DOWNLOAD_DIR || "downloads";
const downloadDirectory = path.join(projectRoot, downloadDirectoryName);
const ytDlpPath = process.env.YTDLP_PATH || "yt-dlp";

if (!fs.existsSync(downloadDirectory)) {
  fs.mkdirSync(downloadDirectory, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(projectRoot, "public")));
app.use(`/${downloadDirectoryName}`, express.static(downloadDirectory));

function getSafeErrorMessage(error) {
  if (!error) {
    return "Unknown error";
  }

  return typeof error.message === "string" && error.message.trim() ? error.message.trim() : "Unknown error";
}

function sendErrorResponse(res, error, fallbackMessage) {
  const statusCode =
    Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600
      ? error.statusCode
      : 500;

  res.status(statusCode).json({
    ok: false,
    message: fallbackMessage,
    error: statusCode < 500 ? getSafeErrorMessage(error) : fallbackMessage
  });
}

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", buildSessionCookie(token));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", buildClearSessionCookie());
}

function getCurrentSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies[SESSION_COOKIE_NAME] || null;
}

function getUserResponse(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email
  };
}

async function createSessionForUser(userId) {
  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = createSessionExpiryDate();

  await pool.query(
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
     VALUES (?, ?, ?)`,
    [userId, tokenHash, expiresAt]
  );

  return token;
}

async function deleteSessionByToken(token) {
  if (!token) {
    return;
  }

  await pool.query(`DELETE FROM auth_sessions WHERE token_hash = ?`, [hashSessionToken(token)]);
}

async function ensureSchema() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS users (
      id INT NOT NULL AUTO_INCREMENT,
      name VARCHAR(80) NOT NULL,
      email VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_users_email (email)
    )`
  );

  await pool.query(
    `CREATE TABLE IF NOT EXISTS auth_sessions (
      id INT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      token_hash VARCHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_auth_sessions_token_hash (token_hash),
      KEY idx_auth_sessions_user_id (user_id),
      KEY idx_auth_sessions_expires_at (expires_at),
      CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );

  const [userIdColumn] = await pool.query(`SHOW COLUMNS FROM download_requests LIKE 'user_id'`);

  if (!userIdColumn.length) {
    await pool.query(`ALTER TABLE download_requests ADD COLUMN user_id INT NULL AFTER id`);
  }

  const [userIdIndex] = await pool.query(`SHOW INDEX FROM download_requests WHERE Key_name = 'idx_download_requests_user_id'`);

  if (!userIdIndex.length) {
    await pool.query(`ALTER TABLE download_requests ADD INDEX idx_download_requests_user_id (user_id)`);
  }
}

async function attachCurrentUser(req, res, next) {
  const sessionToken = getCurrentSessionToken(req);

  if (!sessionToken) {
    req.user = null;
    return next();
  }

  try {
    const sessionTokenHash = hashSessionToken(sessionToken);
    const [rows] = await pool.query(
      `SELECT users.id, users.name, users.email, auth_sessions.id AS session_id
       FROM auth_sessions
       INNER JOIN users ON users.id = auth_sessions.user_id
       WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > NOW()
       LIMIT 1`,
      [sessionTokenHash]
    );

    if (!rows.length) {
      clearSessionCookie(res);
      req.user = null;
      return next();
    }

    req.user = {
      id: rows[0].id,
      name: rows[0].name,
      email: rows[0].email,
      sessionId: rows[0].session_id
    };

    return next();
  } catch (error) {
    return next(error);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      ok: false,
      message: "Please log in to continue.",
      error: "Authentication required."
    });
  }

  return next();
}

function validateDownloadRequestBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("The request body must be a JSON object.");
  }

  const keys = Object.keys(body);

  if (!keys.includes("url")) {
    throw new ValidationError("The request must include a url field.");
  }

  const allowedKeys = new Set(["url", "qualityKey"]);

  if (keys.some((key) => !allowedKeys.has(key))) {
    throw new ValidationError("Only the url and qualityKey fields are allowed in the request.");
  }

  if (typeof body.url !== "string") {
    throw new ValidationError("The url field must be a string.");
  }

  if (keys.includes("qualityKey") && typeof body.qualityKey !== "string") {
    throw new ValidationError("The qualityKey field must be a string.");
  }

  if (body.url.trim().length > MAX_URL_LENGTH) {
    throw new ValidationError(`The link is too long. Maximum length is ${MAX_URL_LENGTH} characters.`);
  }

  const { normalizedUrl, platform } = validateSupportedUrl(body.url);

  return {
    normalizedUrl,
    platform,
    qualityKey: typeof body.qualityKey === "string" ? body.qualityKey.trim() : ""
  };
}

app.use("/api", attachCurrentUser);

app.get("/api/health", async (req, res) => {
  try {
    await testConnection();
    res.json({ ok: true, message: "Server and database are connected." });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Database connection failed.", error: error.message });
  }
});

app.get("/api/auth/session", (req, res) => {
  res.json({
    ok: true,
    authenticated: Boolean(req.user),
    user: getUserResponse(req.user)
  });
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    if (!req.is("application/json")) {
      throw new AuthValidationError("Content-Type must be application/json.");
    }

    const { name, email, password } = validateRegistrationInput(req.body);
    const [existingUsers] = await pool.query(`SELECT id FROM users WHERE email = ? LIMIT 1`, [email]);

    if (existingUsers.length) {
      throw new AuthValidationError("An account with this email already exists.", 409);
    }

    const passwordHash = hashPassword(password);
    const [insertResult] = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES (?, ?, ?)`,
      [name, email, passwordHash]
    );

    const userId = insertResult.insertId;
    const sessionToken = await createSessionForUser(userId);
    setSessionCookie(res, sessionToken);

    res.status(201).json({
      ok: true,
      message: "Registration completed successfully.",
      user: getUserResponse({ id: userId, name, email })
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    if (!req.is("application/json")) {
      throw new AuthValidationError("Content-Type must be application/json.");
    }

    const { email, password } = validateLoginInput(req.body);
    const [rows] = await pool.query(
      `SELECT id, name, email, password_hash
       FROM users
       WHERE email = ?
       LIMIT 1`,
      [email]
    );

    if (!rows.length || !verifyPassword(password, rows[0].password_hash)) {
      throw new AuthValidationError("Invalid email or password.", 401);
    }

    const sessionToken = await createSessionForUser(rows[0].id);
    setSessionCookie(res, sessionToken);

    res.json({
      ok: true,
      message: "Login successful.",
      user: getUserResponse(rows[0])
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", async (req, res, next) => {
  try {
    const sessionToken = getCurrentSessionToken(req);
    await deleteSessionByToken(sessionToken);
    clearSessionCookie(res);
    res.json({ ok: true, message: "Logged out successfully." });
  } catch (error) {
    next(error);
  }
});

app.get("/api/downloads", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, source_url, platform, title, file_path, status, error_message, created_at
       FROM download_requests
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.user.id]
    );

    const items = rows.map((row) => ({
      id: row.id,
      source_url: row.source_url,
      platform: row.platform,
      title: row.title,
      file_path: row.file_path,
      status: row.status,
      error_message: row.error_message,
      created_at: row.created_at,
      download_url: row.file_path ? `/${downloadDirectoryName}/${path.basename(row.file_path)}` : null
    }));

    res.json({ ok: true, items });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Could not load history.", error: error.message });
  }
});

app.get("/api/media-info", requireAuth, async (req, res) => {
  try {
    if (typeof req.query.url !== "string") {
      throw new ValidationError("The request must include a url query parameter.");
    }

    const { normalizedUrl } = validateSupportedUrl(req.query.url);
    const item = await getMediaInfo({
      url: normalizedUrl,
      ytDlpPath
    });

    res.json({
      ok: true,
      item
    });
  } catch (error) {
    sendErrorResponse(res, error, "Could not load media information for this link.");
  }
});

app.post("/api/download", requireAuth, async (req, res) => {
  let requestId = null;

  try {
    if (!req.is("application/json")) {
      throw new ValidationError("Content-Type must be application/json.");
    }

    const { normalizedUrl, platform, qualityKey } = validateDownloadRequestBody(req.body);

    const [insertResult] = await pool.query(
      `INSERT INTO download_requests (user_id, source_url, platform, status)
       VALUES (?, ?, ?, 'pending')`,
      [req.user.id, normalizedUrl, platform]
    );
    requestId = insertResult.insertId;

    const result = await downloadMedia({
      url: normalizedUrl,
      ytDlpPath,
      downloadDir: downloadDirectory,
      qualityKey
    });

    await pool.query(
      `UPDATE download_requests
       SET platform = ?, title = ?, file_path = ?, status = 'completed', error_message = NULL
       WHERE id = ? AND user_id = ?`,
      [result.platform, result.title, result.filePath, requestId, req.user.id]
    );

    res.json({
      ok: true,
      message: "Download completed successfully.",
      item: {
        id: requestId,
        source_url: normalizedUrl,
        platform: result.platform,
        title: result.title,
        file_path: result.filePath,
        download_url: `/${downloadDirectoryName}/${result.fileName}`,
        quality: result.quality,
        status: "completed"
      }
    });
  } catch (error) {
    if (requestId) {
      try {
        await pool.query(
          `UPDATE download_requests
           SET status = 'failed', error_message = ?
           WHERE id = ? AND user_id = ?`,
          [getSafeErrorMessage(error), requestId, req.user.id]
        );
      } catch (updateError) {
      }
    }

    sendErrorResponse(res, error, "Download failed. Check the link or yt-dlp installation.");
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(projectRoot, "public", "index.html"));
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    sendErrorResponse(res, new ValidationError("The JSON body is invalid."), "The request body is invalid.");
    return;
  }

  sendErrorResponse(res, error, "An unexpected server error occurred.");
});

async function startServer() {
  try {
    await testConnection();
    await ensureSchema();
    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error("Server failed to start:", error.message);
    process.exit(1);
  }
}

startServer();
