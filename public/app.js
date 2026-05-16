const state = {
  token: localStorage.getItem("ethara_token") || "",
  user: null,
  view: "dashboard",
  projects: [],
  users: [],
  dashboard: null,
  activeProjectId: null,
  activeProject: null,
  members: [],
  tasks: [],
  modal: null,
  authMode: "login",
  toast: ""
};

const app = document.querySelector("#app");

const statusLabels = {
  todo: "To do",
  in_progress: "In progress",
  review: "Review",
  done: "Done"
};

const priorityLabels = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent"
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "No due date";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "No due date" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function isOverdue(task) {
  if (!task.due_date || task.status === "done") return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(task.due_date) < today;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.details
      ? `${payload.error} ${Object.values(payload.details).join(" ")}`
      : payload.error || "Request failed.";
    throw new Error(message);
  }
  return payload;
}

function setToast(message) {
  state.toast = message;
  render();
  window.clearTimeout(setToast.timer);
  setToast.timer = window.setTimeout(() => {
    state.toast = "";
    render();
  }, 3200);
}

async function boot() {
  if (!state.token) return renderAuth();
  try {
    const { user } = await api("/api/auth/me");
    state.user = user;
    await refreshAll();
  } catch {
    logout(false);
  }
}

async function refreshAll() {
  const [dashboard, projects, users] = await Promise.all([
    api("/api/dashboard"),
    api("/api/projects"),
    api("/api/users")
  ]);
  state.dashboard = dashboard;
  state.projects = projects.projects;
  state.users = users.users;
  if (!state.activeProjectId && state.projects.length) state.activeProjectId = state.projects[0].id;
  if (state.activeProjectId) await loadProject(state.activeProjectId, false);
  render();
}

async function loadProject(id, shouldRender = true) {
  state.activeProjectId = Number(id);
  const [project, tasks] = await Promise.all([
    api(`/api/projects/${id}`),
    api(`/api/projects/${id}/tasks`)
  ]);
  state.activeProject = project.project;
  state.members = project.members;
  state.tasks = tasks.tasks;
  state.canManageProject = project.canManage;
  if (shouldRender) render();
}

function logout(draw = true) {
  localStorage.removeItem("ethara_token");
  Object.assign(state, {
    token: "",
    user: null,
    view: "dashboard",
    projects: [],
    users: [],
    dashboard: null,
    activeProjectId: null,
    activeProject: null,
    members: [],
    tasks: [],
    modal: null
  });
  if (draw) renderAuth();
}

function renderAuth() {
  app.innerHTML = `
    <main class="auth-layout">
      <section class="auth-copy">
        <div class="brand" style="margin-bottom: 30px;">
          <div class="brand-mark">E</div>
          <div>
            <h1 style="font-size: 26px;">Ethara</h1>
            <p>Team Task Manager</p>
          </div>
        </div>
        <h1>Work moves when ownership is visible.</h1>
        <p>Create projects, assign work, track progress, and keep Admin and Member access clean from the first login.</p>
        <div class="proof-strip">
          <span>REST APIs</span>
          <span>SQL relationships</span>
          <span>RBAC</span>
          <span>Railway ready</span>
        </div>
      </section>
      <section class="auth-card">
        <div class="auth-tabs">
          <button class="tab ${state.authMode === "login" ? "active" : ""}" data-auth-tab="login">Login</button>
          <button class="tab ${state.authMode === "signup" ? "active" : ""}" data-auth-tab="signup">Signup</button>
        </div>
        <form class="form" id="authForm">
          ${state.authMode === "signup" ? `
            <label class="field">
              <span>Name</span>
              <input name="name" required minlength="2" autocomplete="name" placeholder="Anika Rao" />
            </label>
          ` : ""}
          <label class="field">
            <span>Email</span>
            <input name="email" required type="email" autocomplete="email" placeholder="you@company.com" />
          </label>
          <label class="field">
            <span>Password</span>
            <input name="password" required type="password" minlength="8" autocomplete="${state.authMode === "login" ? "current-password" : "new-password"}" placeholder="At least 8 characters" />
          </label>
          <button class="btn primary" type="submit">${state.authMode === "login" ? "Login" : "Create account"}</button>
          <p style="margin: 0; color: var(--muted); font-size: 13px; line-height: 1.45;">
            The first account becomes Admin. Later accounts start as Members and can be promoted by an Admin.
          </p>
        </form>
      </section>
      ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ""}
    </main>
  `;
}

function render() {
  if (!state.user) return renderAuth();
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">E</div>
          <div>
            <h1>Ethara</h1>
            <p>Team Task Manager</p>
          </div>
        </div>
        <div class="userbar">
          <span>${escapeHtml(state.user.name)}</span>
          <span class="role-pill">${escapeHtml(state.user.role)}</span>
          <button class="btn ghost" data-action="logout">Logout</button>
        </div>
      </header>
      <div class="app-grid">
        <aside class="sidebar">
          ${navButton("dashboard", "Dashboard", state.dashboard?.totals?.overdue || 0)}
          ${navButton("projects", "Projects", state.projects.length)}
          ${navButton("team", "Team", state.users.length)}
        </aside>
        <main class="main">
          ${state.view === "dashboard" ? renderDashboard() : ""}
          ${state.view === "projects" ? renderProjects() : ""}
          ${state.view === "team" ? renderTeam() : ""}
        </main>
      </div>
      ${state.modal ? renderModal() : ""}
      ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ""}
    </div>
  `;
}

function navButton(view, label, count) {
  return `<button class="nav-button ${state.view === view ? "active" : ""}" data-view="${view}">
    <span>${label}</span><span>${count}</span>
  </button>`;
}

function renderDashboard() {
  const totals = state.dashboard?.totals || {};
  const statusMap = Object.fromEntries((state.dashboard?.byStatus || []).map((item) => [item.status, item.count]));
  return `
    <section class="section-title">
      <div>
        <h2>Command center</h2>
        <p>Live workload, overdue risk, and progress across the projects you can access.</p>
      </div>
      ${state.user.role === "admin" ? `<button class="btn primary" data-modal="project">New project</button>` : ""}
    </section>
    <section class="stats">
      ${stat(totals.projects, "Projects")}
      ${stat(totals.totalTasks, "Total tasks")}
      ${stat(totals.myTasks, "Assigned to me")}
      ${stat(totals.overdue, "Overdue")}
    </section>
    <section class="content-grid">
      <div class="panel">
        <div class="panel-head">
          <h3>Upcoming work</h3>
          <span class="role-pill">${totals.completed || 0} completed</span>
        </div>
        <div class="list">
          ${(state.dashboard?.upcoming || []).length ? state.dashboard.upcoming.map(taskCard).join("") : empty("No open tasks yet.")}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Status mix</h3></div>
        <div class="list">
          ${Object.keys(statusLabels).map((key) => `
            <div class="member-row">
              <strong>${statusLabels[key]}</strong>
              <span class="status-pill ${key}">${statusMap[key] || 0}</span>
            </div>
          `).join("")}
        </div>
      </div>
    </section>
  `;
}

function stat(value = 0, label) {
  return `<div class="stat"><strong>${Number(value) || 0}</strong><span>${label}</span></div>`;
}

function renderProjects() {
  return `
    <section class="section-title">
      <div>
        <h2>Projects</h2>
        <p>Manage team membership, assign tasks, and keep delivery status visible.</p>
      </div>
      ${state.user.role === "admin" ? `<button class="btn primary" data-modal="project">New project</button>` : ""}
    </section>
    <section class="content-grid">
      <div class="list">
        ${state.projects.length ? state.projects.map(projectCard).join("") : empty("No projects yet. Admins can create the first one.")}
      </div>
      <div class="panel">
        ${state.activeProject ? renderProjectDetail() : empty("Select a project to see tasks and members.")}
      </div>
    </section>
  `;
}

function projectCard(project) {
  const progress = project.task_count ? Math.round((project.done_count / project.task_count) * 100) : 0;
  return `
    <article class="project-card">
      <header>
        <div>
          <h3>${escapeHtml(project.name)}</h3>
          <p>${escapeHtml(project.description || "No description added.")}</p>
        </div>
        <span class="status-pill ${project.status}">${escapeHtml(project.status)}</span>
      </header>
      <div class="progress-track"><div class="progress-fill" style="width: ${progress}%"></div></div>
      <div class="meta">
        <span>${progress}% done</span>
        <span>${project.task_count || 0} tasks</span>
        <span>${project.member_count || 0} members</span>
        <span>Owner: ${escapeHtml(project.owner_name)}</span>
      </div>
      <div class="task-actions">
        <button class="btn dark" data-open-project="${project.id}">Open</button>
        ${state.user.role === "admin" ? `<button class="btn ghost" data-edit-project="${project.id}">Edit</button>` : ""}
      </div>
    </article>
  `;
}

function renderProjectDetail() {
  const canManage = Boolean(state.canManageProject);
  return `
    <div class="panel-head">
      <div>
        <h3>${escapeHtml(state.activeProject.name)}</h3>
        <p style="margin: 6px 0 0; color: var(--muted);">${escapeHtml(state.activeProject.description || "No description.")}</p>
      </div>
      ${canManage ? `<button class="btn primary" data-modal="task">New task</button>` : ""}
    </div>
    <div class="list" style="margin-bottom: 18px;">
      ${state.tasks.length ? state.tasks.map(taskCard).join("") : empty("No tasks in this project.")}
    </div>
    <div class="panel-head">
      <h3>Project team</h3>
      ${canManage ? `<button class="btn ghost" data-modal="member">Add member</button>` : ""}
    </div>
    <div class="list">
      ${state.members.map(memberRow).join("")}
    </div>
  `;
}

function taskCard(task) {
  const canEdit = state.canManageProject || task.assignee_id === state.user.id || state.user.role === "admin";
  return `
    <article class="task-row">
      <header>
        <div>
          <h4>${escapeHtml(task.title)}</h4>
          <p>${escapeHtml(task.description || "No description.")}</p>
        </div>
        <div class="task-actions">
          <span class="status-pill ${task.status}">${statusLabels[task.status] || task.status}</span>
          <span class="priority-pill ${task.priority}">${priorityLabels[task.priority] || task.priority}</span>
        </div>
      </header>
      <div class="meta">
        <span>${escapeHtml(task.project_name)}</span>
        <span>Assigned: ${escapeHtml(task.assignee_name || "Unassigned")}</span>
        <span style="${isOverdue(task) ? "color: var(--danger);" : ""}">Due: ${formatDate(task.due_date)}</span>
      </div>
      ${canEdit ? `
        <div class="task-actions">
          <select data-status-task="${task.id}" aria-label="Update status">
            ${Object.entries(statusLabels).map(([key, label]) => `<option value="${key}" ${task.status === key ? "selected" : ""}>${label}</option>`).join("")}
          </select>
          ${state.canManageProject || state.user.role === "admin" ? `<button class="btn ghost" data-edit-task="${task.id}">Edit</button>` : ""}
        </div>
      ` : ""}
    </article>
  `;
}

function memberRow(member) {
  const canRemove = state.canManageProject && member.user_id !== state.activeProject?.owner_id;
  return `
    <div class="member-row" style="padding: 12px;">
      <div>
        <strong>${escapeHtml(member.name)}</strong>
        <div class="meta">${escapeHtml(member.email)}</div>
      </div>
      <div class="task-actions">
        <span class="role-pill">${escapeHtml(member.role)}</span>
        ${canRemove ? `<button class="btn ghost" data-remove-member="${member.user_id}">Remove</button>` : ""}
      </div>
    </div>
  `;
}

function renderTeam() {
  return `
    <section class="section-title">
      <div>
        <h2>Team</h2>
        <p>Admins can promote users. Members can collaborate inside projects they are assigned to.</p>
      </div>
    </section>
    <section class="panel">
      <div class="list">
        ${state.users.map((user) => `
          <div class="member-row" style="padding: 14px;">
            <div>
              <strong>${escapeHtml(user.name)}</strong>
              <div class="meta">${escapeHtml(user.email)}</div>
            </div>
            <div class="task-actions">
              <span class="role-pill">${escapeHtml(user.role)}</span>
              ${state.user.role === "admin" && user.id !== state.user.id ? `
                <select data-user-role="${user.id}" aria-label="Change role">
                  <option value="member" ${user.role === "member" ? "selected" : ""}>Member</option>
                  <option value="admin" ${user.role === "admin" ? "selected" : ""}>Admin</option>
                </select>
              ` : ""}
            </div>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function empty(message) {
  return `<div class="empty">${escapeHtml(message)}</div>`;
}

function renderModal() {
  if (state.modal === "project") return projectModal();
  if (state.modal === "task") return taskModal();
  if (state.modal === "member") return memberModal();
  return "";
}

function projectModal() {
  const project = state.editingProject || {};
  return `
    <div class="modal-backdrop">
      <section class="modal-card">
        <div class="modal-head">
          <h3>${project.id ? "Edit project" : "New project"}</h3>
          <button class="btn ghost" data-close-modal>Close</button>
        </div>
        <form class="form" id="projectForm">
          <label class="field"><span>Name</span><input name="name" required minlength="3" value="${escapeHtml(project.name || "")}" /></label>
          <label class="field"><span>Description</span><textarea name="description">${escapeHtml(project.description || "")}</textarea></label>
          ${project.id ? `
            <label class="field"><span>Status</span><select name="status">
              <option value="active" ${project.status === "active" ? "selected" : ""}>Active</option>
              <option value="completed" ${project.status === "completed" ? "selected" : ""}>Completed</option>
              <option value="archived" ${project.status === "archived" ? "selected" : ""}>Archived</option>
            </select></label>
          ` : ""}
          <button class="btn primary" type="submit">Save project</button>
        </form>
      </section>
    </div>
  `;
}

function taskModal() {
  const task = state.editingTask || {};
  const memberIds = new Set(state.members.map((member) => member.user_id));
  return `
    <div class="modal-backdrop">
      <section class="modal-card">
        <div class="modal-head">
          <h3>${task.id ? "Edit task" : "New task"}</h3>
          <button class="btn ghost" data-close-modal>Close</button>
        </div>
        <form class="form" id="taskForm">
          <label class="field"><span>Title</span><input name="title" required minlength="3" value="${escapeHtml(task.title || "")}" /></label>
          <label class="field"><span>Description</span><textarea name="description">${escapeHtml(task.description || "")}</textarea></label>
          <div class="split">
            <label class="field"><span>Assignee</span><select name="assignee_id">
              <option value="">Unassigned</option>
              ${state.users.filter((user) => memberIds.has(user.id)).map((user) => `<option value="${user.id}" ${task.assignee_id === user.id ? "selected" : ""}>${escapeHtml(user.name)}</option>`).join("")}
            </select></label>
            <label class="field"><span>Due date</span><input name="due_date" type="date" value="${escapeHtml(task.due_date || "")}" /></label>
          </div>
          <div class="split">
            <label class="field"><span>Status</span><select name="status">
              ${Object.entries(statusLabels).map(([key, label]) => `<option value="${key}" ${task.status === key ? "selected" : ""}>${label}</option>`).join("")}
            </select></label>
            <label class="field"><span>Priority</span><select name="priority">
              ${Object.entries(priorityLabels).map(([key, label]) => `<option value="${key}" ${task.priority === key || (!task.priority && key === "medium") ? "selected" : ""}>${label}</option>`).join("")}
            </select></label>
          </div>
          <button class="btn primary" type="submit">Save task</button>
        </form>
      </section>
    </div>
  `;
}

function memberModal() {
  const existing = new Set(state.members.map((member) => member.user_id));
  const available = state.users.filter((user) => !existing.has(user.id));
  return `
    <div class="modal-backdrop">
      <section class="modal-card">
        <div class="modal-head">
          <h3>Add member</h3>
          <button class="btn ghost" data-close-modal>Close</button>
        </div>
        ${available.length ? `
          <form class="form" id="memberForm">
            <label class="field"><span>User</span><select name="user_id">
              ${available.map((user) => `<option value="${user.id}">${escapeHtml(user.name)} (${escapeHtml(user.email)})</option>`).join("")}
            </select></label>
            <label class="field"><span>Project role</span><select name="role">
              <option value="member">Member</option>
              <option value="admin">Project admin</option>
            </select></label>
            <button class="btn primary" type="submit">Add to project</button>
          </form>
        ` : empty("Every user is already on this project.")}
      </section>
    </div>
  `;
}

app.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  try {
    if (target.dataset.authTab) {
      state.authMode = target.dataset.authTab;
      renderAuth();
    }
    if (target.dataset.action === "logout") logout();
    if (target.dataset.view) {
      state.view = target.dataset.view;
      render();
    }
    if (target.dataset.modal) {
      state.editingProject = null;
      state.editingTask = null;
      state.modal = target.dataset.modal;
      render();
    }
    if (target.dataset.closeModal !== undefined) {
      state.modal = null;
      state.editingProject = null;
      state.editingTask = null;
      render();
    }
    if (target.dataset.openProject) {
      state.view = "projects";
      await loadProject(target.dataset.openProject);
    }
    if (target.dataset.editProject) {
      state.editingProject = state.projects.find((project) => project.id === Number(target.dataset.editProject));
      state.modal = "project";
      render();
    }
    if (target.dataset.editTask) {
      state.editingTask = state.tasks.find((task) => task.id === Number(target.dataset.editTask))
        || state.dashboard?.upcoming?.find((task) => task.id === Number(target.dataset.editTask));
      if (state.editingTask?.project_id && state.editingTask.project_id !== state.activeProjectId) {
        await loadProject(state.editingTask.project_id, false);
      }
      state.modal = "task";
      render();
    }
    if (target.dataset.removeMember) {
      await api(`/api/projects/${state.activeProjectId}/members/${target.dataset.removeMember}`, { method: "DELETE" });
      await refreshAll();
      setToast("Member removed from project.");
    }
  } catch (error) {
    setToast(error.message);
  }
});

app.addEventListener("change", async (event) => {
  const target = event.target;
  try {
    if (target.matches("[data-status-task]")) {
      await api(`/api/tasks/${target.dataset.statusTask}`, {
        method: "PATCH",
        body: JSON.stringify({ status: target.value })
      });
      await refreshAll();
      setToast("Task status updated.");
    }
    if (target.matches("[data-user-role]")) {
      await api(`/api/users/${target.dataset.userRole}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role: target.value })
      });
      await refreshAll();
      setToast("User role updated.");
    }
  } catch (error) {
    setToast(error.message);
  }
});

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    if (form.id === "authForm") {
      const payload = await api(`/api/auth/${state.authMode}`, {
        method: "POST",
        body: JSON.stringify(data)
      });
      state.token = payload.token;
      state.user = payload.user;
      localStorage.setItem("ethara_token", state.token);
      await refreshAll();
      setToast(`Signed in as ${payload.user.role}.`);
    }
    if (form.id === "projectForm") {
      const project = state.editingProject;
      await api(project?.id ? `/api/projects/${project.id}` : "/api/projects", {
        method: project?.id ? "PATCH" : "POST",
        body: JSON.stringify(data)
      });
      state.modal = null;
      state.editingProject = null;
      await refreshAll();
      setToast("Project saved.");
    }
    if (form.id === "taskForm") {
      const task = state.editingTask;
      await api(task?.id ? `/api/tasks/${task.id}` : `/api/projects/${state.activeProjectId}/tasks`, {
        method: task?.id ? "PATCH" : "POST",
        body: JSON.stringify(data)
      });
      state.modal = null;
      state.editingTask = null;
      await refreshAll();
      setToast("Task saved.");
    }
    if (form.id === "memberForm") {
      await api(`/api/projects/${state.activeProjectId}/members`, {
        method: "POST",
        body: JSON.stringify(data)
      });
      state.modal = null;
      await refreshAll();
      setToast("Member added.");
    }
  } catch (error) {
    setToast(error.message);
  }
});

boot();
