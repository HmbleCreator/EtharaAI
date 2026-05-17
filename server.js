import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 3000);
const jwtSecret = process.env.JWT_SECRET || "dev-secret-change-me-before-deploy";
const dbPath = resolve(process.env.DATABASE_PATH || join(__dirname, "data", "ethara.sqlite"));

mkdirSync(resolve(dbPath, ".."), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')) DEFAULT 'member',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'archived')) DEFAULT 'active',
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS project_members (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')) DEFAULT 'member',
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'review', 'done')) DEFAULT 'todo',
    priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')) DEFAULT 'medium',
    due_date TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
};

const fail = (res, status, message, details = undefined) => json(res, status, { error: message, details });

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
const clean = (value) => String(value || "").trim();
const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const now = () => new Date().toISOString();

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const next = pbkdf2Sync(password, salt, 120000, 32, "sha256");
  const prev = Buffer.from(hash, "hex");
  return prev.length === next.length && timingSafeEqual(prev, next);
}

function seedAdminFromEnv() {
  const email = normalizeEmail(process.env.SEED_ADMIN_EMAIL);
  const password = String(process.env.SEED_ADMIN_PASSWORD || "");
  const name = clean(process.env.SEED_ADMIN_NAME || "Ethara Admin");
  if (!email || !password) return;
  if (!isEmail(email) || password.length < 8) {
    console.warn("Skipping seeded admin: SEED_ADMIN_EMAIL or SEED_ADMIN_PASSWORD is invalid.");
    return;
  }
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    db.prepare("UPDATE users SET name = ?, password_hash = ?, role = 'admin' WHERE id = ?").run(name, hashPassword(password), existing.id);
    return;
  }
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')").run(name, email, hashPassword(password));
}

seedAdminFromEnv();

const demoMembers = [
  ["Aarav Mehta", "aarav@etharaai.app"],
  ["Maya Iyer", "maya@etharaai.app"],
  ["Kabir Sharma", "kabir@etharaai.app"],
  ["Nisha Rao", "nisha@etharaai.app"],
  ["Rohan Kapoor", "rohan@etharaai.app"]
];

function seedDemoMembersFromEnv() {
  if (String(process.env.SEED_DEMO_MEMBERS || "").toLowerCase() !== "true") return;
  const password = String(process.env.SEED_DEMO_MEMBER_PASSWORD || "");
  if (password.length < 8) {
    console.warn("Skipping demo members: SEED_DEMO_MEMBER_PASSWORD must be at least 8 characters.");
    return;
  }
  const insert = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'member')");
  const update = db.prepare("UPDATE users SET name = ?, password_hash = ?, role = 'member' WHERE email = ?");
  const find = db.prepare("SELECT id FROM users WHERE email = ?");
  for (const [name, email] of demoMembers) {
    const existing = find.get(email);
    if (existing) {
      update.run(name, hashPassword(password), email);
    } else {
      insert.run(name, email, hashPassword(password));
    }
  }
}

seedDemoMembersFromEnv();

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function signToken(user) {
  const payload = {
    sub: user.id,
    role: user.role,
    name: user.name,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7
  };
  const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  const sig = createHmac("sha256", jwtSecret).update(unsigned).digest("base64url");
  return `${unsigned}.${sig}`;
}

function verifyToken(token) {
  const [header, payload, sig] = String(token || "").split(".");
  if (!header || !payload || !sig) return null;
  const expected = createHmac("sha256", jwtSecret).update(`${header}.${payload}`).digest("base64url");
  if (Buffer.byteLength(sig) !== Buffer.byteLength(expected)) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) return null;
  return parsed;
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
  });
}

function getUserFromRequest(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const parsed = verifyToken(token);
  if (!parsed) return null;
  return db.prepare("SELECT id, name, email, role, created_at FROM users WHERE id = ?").get(parsed.sub) || null;
}

const userSelect = "id, name, email, role, created_at";
const taskSelect = `
  SELECT t.*, p.name AS project_name, u.name AS assignee_name, u.email AS assignee_email, c.name AS creator_name
  FROM tasks t
  JOIN projects p ON p.id = t.project_id
  LEFT JOIN users u ON u.id = t.assignee_id
  JOIN users c ON c.id = t.created_by
`;

function projectForUser(projectId, user) {
  if (user.role === "admin") {
    return db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  }
  return db.prepare(`
    SELECT p.*
    FROM projects p
    JOIN project_members pm ON pm.project_id = p.id
    WHERE p.id = ? AND pm.user_id = ?
  `).get(projectId, user.id);
}

function canManageProject(projectId, user) {
  if (user.role === "admin") return true;
  const membership = db.prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, user.id);
  return membership?.role === "admin";
}

function requireAuth(req, res) {
  const user = getUserFromRequest(req);
  if (!user) fail(res, 401, "Sign in required.");
  return user;
}

function requireAdmin(user, res) {
  if (user.role !== "admin") {
    fail(res, 403, "Admin access required.");
    return false;
  }
  return true;
}

function validateTaskInput(input, partial = false) {
  const errors = {};
  const out = {};
  if (!partial || "title" in input) {
    out.title = clean(input.title);
    if (out.title.length < 3) errors.title = "Title must be at least 3 characters.";
  }
  if (!partial || "description" in input) out.description = clean(input.description);
  if (!partial || "status" in input) {
    out.status = clean(input.status || "todo");
    if (!["todo", "in_progress", "review", "done"].includes(out.status)) errors.status = "Choose a valid status.";
  }
  if (!partial || "priority" in input) {
    out.priority = clean(input.priority || "medium");
    if (!["low", "medium", "high", "urgent"].includes(out.priority)) errors.priority = "Choose a valid priority.";
  }
  if (!partial || "due_date" in input) {
    out.due_date = clean(input.due_date);
    if (out.due_date && Number.isNaN(Date.parse(out.due_date))) errors.due_date = "Due date must be valid.";
  }
  if (!partial || "assignee_id" in input) {
    out.assignee_id = input.assignee_id ? Number(input.assignee_id) : null;
    if (out.assignee_id !== null && !Number.isInteger(out.assignee_id)) errors.assignee_id = "Assignee must be valid.";
  }
  return { out, errors };
}

function userCanSeeTask(task, user) {
  if (user.role === "admin") return true;
  return Boolean(projectForUser(task.project_id, user));
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

function matchRoute(method, pathname) {
  for (const item of routes) {
    if (item.method !== method) continue;
    const paramNames = [];
    const regex = new RegExp(`^${item.pattern.replace(/:([A-Za-z_]+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    })}$`);
    const match = pathname.match(regex);
    if (match) {
      return {
        handler: item.handler,
        params: Object.fromEntries(paramNames.map((name, index) => [name, Number(match[index + 1]) || match[index + 1]]))
      };
    }
  }
  return null;
}

route("POST", "/api/auth/signup", async (req, res) => {
  const body = await readBody(req);
  const name = clean(body.name);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  const errors = {};
  if (name.length < 2) errors.name = "Name must be at least 2 characters.";
  if (!isEmail(email)) errors.email = "Enter a valid email.";
  if (password.length < 8) errors.password = "Password must be at least 8 characters.";
  if (Object.keys(errors).length) return fail(res, 422, "Validation failed.", errors);

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return fail(res, 409, "An account with that email already exists.");

  const result = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'member')").run(name, email, hashPassword(password));
  const user = db.prepare(`SELECT ${userSelect} FROM users WHERE id = ?`).get(Number(result.lastInsertRowid));
  json(res, 201, { user, token: signToken(user) });
});

route("POST", "/api/auth/login", async (req, res) => {
  const body = await readBody(req);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  const record = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!record || !verifyPassword(password, record.password_hash)) return fail(res, 401, "Invalid email or password.");
  const user = db.prepare(`SELECT ${userSelect} FROM users WHERE id = ?`).get(record.id);
  json(res, 200, { user, token: signToken(user) });
});

route("GET", "/api/auth/me", async (req, res) => {
  const user = requireAuth(req, res);
  if (user) json(res, 200, { user });
});

route("GET", "/api/users", async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const users = db.prepare(`SELECT ${userSelect} FROM users ORDER BY name`).all();
  json(res, 200, { users });
});

route("PATCH", "/api/users/:id/role", async (req, res, params) => {
  const user = requireAuth(req, res);
  if (!user || !requireAdmin(user, res)) return;
  const body = await readBody(req);
  const role = clean(body.role);
  if (!["admin", "member"].includes(role)) return fail(res, 422, "Choose a valid role.");
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(params.id);
  if (!target) return fail(res, 404, "User not found.");
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, params.id);
  json(res, 200, { user: db.prepare(`SELECT ${userSelect} FROM users WHERE id = ?`).get(params.id) });
});

route("GET", "/api/projects", async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const projects = user.role === "admin"
    ? db.prepare(`
        SELECT p.*, u.name AS owner_name,
          (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) AS member_count,
          (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
          (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count
        FROM projects p JOIN users u ON u.id = p.owner_id
        ORDER BY p.updated_at DESC
      `).all()
    : db.prepare(`
        SELECT p.*, u.name AS owner_name, pm.role AS membership_role,
          (SELECT COUNT(*) FROM project_members pm2 WHERE pm2.project_id = p.id) AS member_count,
          (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
          (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count
        FROM projects p
        JOIN users u ON u.id = p.owner_id
        JOIN project_members pm ON pm.project_id = p.id
        WHERE pm.user_id = ?
        ORDER BY p.updated_at DESC
      `).all(user.id);
  json(res, 200, { projects });
});

route("POST", "/api/projects", async (req, res) => {
  const user = requireAuth(req, res);
  if (!user || !requireAdmin(user, res)) return;
  const body = await readBody(req);
  const name = clean(body.name);
  const description = clean(body.description);
  if (name.length < 3) return fail(res, 422, "Project name must be at least 3 characters.");
  const result = db.prepare("INSERT INTO projects (name, description, owner_id) VALUES (?, ?, ?)").run(name, description, user.id);
  const projectId = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'admin')").run(projectId, user.id);
  json(res, 201, { project: db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) });
});

route("GET", "/api/projects/:id", async (req, res, params) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const project = projectForUser(params.id, user);
  if (!project) return fail(res, 404, "Project not found.");
  const members = db.prepare(`
    SELECT pm.project_id, pm.user_id, pm.role, pm.joined_at, u.name, u.email
    FROM project_members pm
    JOIN users u ON u.id = pm.user_id
    WHERE pm.project_id = ?
    ORDER BY pm.role, u.name
  `).all(params.id);
  json(res, 200, { project, members, canManage: canManageProject(params.id, user) });
});

route("PATCH", "/api/projects/:id", async (req, res, params) => {
  const user = requireAuth(req, res);
  if (!user) return;
  if (!canManageProject(params.id, user)) return fail(res, 403, "Project admin access required.");
  const body = await readBody(req);
  const current = db.prepare("SELECT * FROM projects WHERE id = ?").get(params.id);
  if (!current) return fail(res, 404, "Project not found.");
  const name = "name" in body ? clean(body.name) : current.name;
  const description = "description" in body ? clean(body.description) : current.description;
  const status = "status" in body ? clean(body.status) : current.status;
  if (name.length < 3) return fail(res, 422, "Project name must be at least 3 characters.");
  if (!["active", "completed", "archived"].includes(status)) return fail(res, 422, "Choose a valid project status.");
  db.prepare("UPDATE projects SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?").run(name, description, status, now(), params.id);
  json(res, 200, { project: db.prepare("SELECT * FROM projects WHERE id = ?").get(params.id) });
});

route("DELETE", "/api/projects/:id", async (req, res, params) => {
  const user = requireAuth(req, res);
  if (!user || !requireAdmin(user, res)) return;
  db.prepare("DELETE FROM projects WHERE id = ?").run(params.id);
  json(res, 200, { ok: true });
});

route("POST", "/api/projects/:id/members", async (req, res, params) => {
  const user = requireAuth(req, res);
  if (!user) return;
  if (!canManageProject(params.id, user)) return fail(res, 403, "Project admin access required.");
  const body = await readBody(req);
  const userId = Number(body.user_id);
  const role = clean(body.role || "member");
  if (!Number.isInteger(userId)) return fail(res, 422, "Choose a valid user.");
  if (!["admin", "member"].includes(role)) return fail(res, 422, "Choose a valid project role.");
  if (!db.prepare("SELECT id FROM users WHERE id = ?").get(userId)) return fail(res, 404, "User not found.");
  if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(params.id)) return fail(res, 404, "Project not found.");
  db.prepare(`
    INSERT INTO project_members (project_id, user_id, role)
    VALUES (?, ?, ?)
    ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role
  `).run(params.id, userId, role);
  json(res, 200, { ok: true });
});

route("DELETE", "/api/projects/:id/members/:userId", async (req, res, params) => {
  const user = requireAuth(req, res);
  if (!user) return;
  if (!canManageProject(params.id, user)) return fail(res, 403, "Project admin access required.");
  const project = db.prepare("SELECT owner_id FROM projects WHERE id = ?").get(params.id);
  if (!project) return fail(res, 404, "Project not found.");
  if (project.owner_id === params.userId) return fail(res, 409, "Project owner cannot be removed.");
  db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(params.id, params.userId);
  json(res, 200, { ok: true });
});

route("GET", "/api/projects/:id/tasks", async (req, res, params) => {
  const user = requireAuth(req, res);
  if (!user) return;
  if (!projectForUser(params.id, user)) return fail(res, 404, "Project not found.");
  const tasks = db.prepare(`${taskSelect} WHERE t.project_id = ? ORDER BY COALESCE(t.due_date, '9999-12-31'), t.created_at DESC`).all(params.id);
  json(res, 200, { tasks });
});

route("POST", "/api/projects/:id/tasks", async (req, res, params) => {
  const user = requireAuth(req, res);
  if (!user) return;
  if (!canManageProject(params.id, user)) return fail(res, 403, "Project admin access required.");
  const body = await readBody(req);
  if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(params.id)) return fail(res, 404, "Project not found.");
  const { out, errors } = validateTaskInput(body);
  if (Object.keys(errors).length) return fail(res, 422, "Validation failed.", errors);
  if (out.assignee_id && !db.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?").get(params.id, out.assignee_id)) {
    return fail(res, 422, "Assignee must be a project member.");
  }
  const result = db.prepare(`
    INSERT INTO tasks (project_id, title, description, assignee_id, status, priority, due_date, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(params.id, out.title, out.description, out.assignee_id, out.status, out.priority, out.due_date || null, user.id);
  db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now(), params.id);
  const task = db.prepare(`${taskSelect} WHERE t.id = ?`).get(Number(result.lastInsertRowid));
  json(res, 201, { task });
});

route("PATCH", "/api/tasks/:id", async (req, res, params) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const current = db.prepare("SELECT * FROM tasks WHERE id = ?").get(params.id);
  if (!current || !userCanSeeTask(current, user)) return fail(res, 404, "Task not found.");
  const canManage = canManageProject(current.project_id, user);
  const body = await readBody(req);
  if (!canManage) {
    const keys = Object.keys(body);
    if (current.assignee_id !== user.id || keys.some((key) => key !== "status")) {
      return fail(res, 403, "Only project admins can edit task details.");
    }
  }
  const { out, errors } = validateTaskInput({ ...current, ...body }, true);
  if (Object.keys(errors).length) return fail(res, 422, "Validation failed.", errors);
  const next = { ...current, ...out };
  if (canManage && next.assignee_id && !db.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?").get(current.project_id, next.assignee_id)) {
    return fail(res, 422, "Assignee must be a project member.");
  }
  db.prepare(`
    UPDATE tasks
    SET title = ?, description = ?, assignee_id = ?, status = ?, priority = ?, due_date = ?, updated_at = ?
    WHERE id = ?
  `).run(next.title, next.description, next.assignee_id, next.status, next.priority, next.due_date || null, now(), params.id);
  db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now(), current.project_id);
  json(res, 200, { task: db.prepare(`${taskSelect} WHERE t.id = ?`).get(params.id) });
});

route("DELETE", "/api/tasks/:id", async (req, res, params) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(params.id);
  if (!task) return fail(res, 404, "Task not found.");
  if (!canManageProject(task.project_id, user)) return fail(res, 403, "Project admin access required.");
  db.prepare("DELETE FROM tasks WHERE id = ?").run(params.id);
  db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now(), task.project_id);
  json(res, 200, { ok: true });
});

route("GET", "/api/dashboard", async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const projectFilter = user.role === "admin" ? "" : "JOIN project_members pm ON pm.project_id = t.project_id AND pm.user_id = ?";
  const args = user.role === "admin" ? [] : [user.id];
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN t.assignee_id = ? THEN 1 ELSE 0 END) AS mine,
      SUM(CASE WHEN t.status != 'done' AND t.due_date IS NOT NULL AND date(t.due_date) < date('now') THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
    FROM tasks t
    ${projectFilter}
  `).get(user.id, ...args);
  const byStatus = db.prepare(`
    SELECT t.status, COUNT(*) AS count
    FROM tasks t
    ${projectFilter}
    GROUP BY t.status
  `).all(...args);
  const upcoming = db.prepare(`
    ${taskSelect}
    ${user.role === "admin" ? "" : "JOIN project_members pm ON pm.project_id = t.project_id AND pm.user_id = ?"}
    WHERE t.status != 'done'
    ORDER BY COALESCE(t.due_date, '9999-12-31'), t.priority DESC
    LIMIT 8
  `).all(...args);
  const projectCount = user.role === "admin"
    ? db.prepare("SELECT COUNT(*) AS count FROM projects").get().count
    : db.prepare("SELECT COUNT(*) AS count FROM project_members WHERE user_id = ?").get(user.id).count;
  json(res, 200, {
    totals: {
      projects: projectCount,
      totalTasks: totals.total || 0,
      myTasks: totals.mine || 0,
      overdue: totals.overdue || 0,
      completed: totals.done || 0
    },
    byStatus,
    upcoming
  });
});

function serveStatic(req, res, pathname) {
  const target = pathname === "/" ? join(publicDir, "index.html") : join(publicDir, pathname);
  const resolved = resolve(target);
  if (!resolved.startsWith(publicDir) || !existsSync(resolved)) {
    const fallback = join(publicDir, "index.html");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(fallback));
    return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon"
  };
  res.writeHead(200, {
    "content-type": types[extname(resolved)] || "application/octet-stream",
    "cache-control": "no-store"
  });
  res.end(readFileSync(resolved));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type, authorization",
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS"
      });
      return res.end();
    }
    if (url.pathname.startsWith("/api/")) {
      const matched = matchRoute(req.method || "GET", url.pathname);
      if (!matched) return fail(res, 404, "API route not found.");
      return await matched.handler(req, res, matched.params);
    }
    serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (error) {
    console.error(error);
    fail(res, 500, error.message || "Unexpected server error.");
  }
});

server.listen(port, () => {
  console.log(`Ethara Team Task Manager running on http://localhost:${port}`);
  console.log(`SQLite database: ${dbPath}`);
});
