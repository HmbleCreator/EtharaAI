# Ethara Team Task Manager

A production-ready full-stack task manager for project teams. Users can sign up, log in, create projects, manage project teams, assign tasks, update status, and track dashboard progress with Admin/Member role-based access.

## Features

- Signup and login with salted password hashing and JWT sessions
- First registered user becomes `admin`; later users start as `member`
- Admin-only project creation and global role management
- Project-level Admin/Member access for team management and task assignment
- Task status, priority, assignee, due-date, overdue, and progress tracking
- REST API backed by SQLite with foreign-key relationships and validations
- Clean responsive frontend served by the same Node app
- Railway-ready config with no build step or package install required

## Tech Stack

- Node.js 24
- Built-in `node:http` REST server
- Built-in `node:sqlite` SQL database
- Browser-native HTML, CSS, and JavaScript

## Local Setup

```bash
node server.js
```

Open `http://localhost:3000`.

Optional environment variables:

```bash
PORT=3000
JWT_SECRET=replace-with-a-long-random-secret
DATABASE_PATH=./data/ethara.sqlite
```

## Railway Deployment

1. Push this repository to GitHub.
2. Create a new Railway project from the GitHub repository.
3. Add environment variables:
   - `JWT_SECRET`: a long random string
   - `DATABASE_PATH`: `/data/ethara.sqlite`
4. Add a Railway volume mounted at `/data` so SQLite data persists across deploys.
5. Deploy. Railway will run `node server.js` from `railway.toml`.

## REST API Overview

Auth:

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/auth/me`

Users:

- `GET /api/users`
- `PATCH /api/users/:id/role` Admin only

Projects:

- `GET /api/projects`
- `POST /api/projects` Admin only
- `GET /api/projects/:id`
- `PATCH /api/projects/:id` Admin or project admin
- `DELETE /api/projects/:id` Admin only
- `POST /api/projects/:id/members` Admin or project admin
- `DELETE /api/projects/:id/members/:userId` Admin or project admin

Tasks:

- `GET /api/projects/:id/tasks`
- `POST /api/projects/:id/tasks` Admin or project admin
- `PATCH /api/tasks/:id` Admin/project admin; assigned members may update status
- `DELETE /api/tasks/:id` Admin or project admin

Dashboard:

- `GET /api/dashboard`

## Live Deployment

- Live app: https://etharaai-production-711d.up.railway.app
- Railway deployment: https://railway.com/project/d8f21dcd-0014-4810-b668-346cffbfd9ee/service/c9b1bee4-2261-4e88-9b65-0591b18afe0f
- GitHub repo: https://github.com/HmbleCreator/EtharaAI

## Submission

- Live URL: https://etharaai-production-711d.up.railway.app
- GitHub repo: https://github.com/HmbleCreator/EtharaAI
- README: this file
