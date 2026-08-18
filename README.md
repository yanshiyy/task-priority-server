# 任务优先级决策器 · 多账户版

在原有"重要度 × 紧急度"模型基础上增加**独立账户**能力：5 个预置账户，多人可同时登录使用，各账户任务数据完全隔离、互不可见。数据存于服务端 SQLite，前端零改动体验。

## 技术要点

- **零运行时依赖**：仅用 Node.js 内置 `http` + `node:sqlite` + `crypto`（需 Node ≥ 22.5，建议 24）。
- **账户**：默认 5 个（`user1`…`user5`），首次启动自动生成随机初始密码，打印到控制台并写入 `data/初始密码.txt`；用户登录后可在页面内修改密码。
- **隔离与并发**：每账户独立任务表；写入采用乐观锁（`rev` 版本号），冲突返回 409，前端自动提示刷新，避免同一账户多设备互相覆盖。
- **安全**：密码用 `scrypt` 加盐散列存储；登录态为带过期时间的会话令牌（内存态，重启后需重新登录）。

## 快速开始（本地）

```bash
cd task-priority-server
node server.js
```

- 打开 http://localhost:8787（`PORT` 环境变量可改端口）
- 首次启动控制台会打印 5 个账户的初始密码，请立即分发并提醒修改。

**自定义账户名**（个数与名称均可改，默认 5 个）：

```bash
ACCOUNTS="张三,李四,王五,赵六,孙七" node server.js
```

**重置某账户密码**：

```bash
node reset-password.js user1
```

## 部署到公网（多人远程使用）

本服务端就是一个普通 Node 进程，可部署到任意支持 Node 的平台：

- **Render / Railway / Fly.io / Vercel**：上传 `task-priority-server`（**不含** `node_modules` 和 `data`），启动命令 `node server.js`，配置环境变量 `PORT`、`ACCOUNTS`、`DATA_DIR`（如挂载持久化磁盘 `/data`）。
- 部署后把服务端地址发给 5 位成员即可；每人用分配账户登录，数据互不干扰。
- 若前端想单独放在 GitHub Pages，只需把 `public/config.js` 里的 `window.API_BASE` 改为服务端地址（服务端已开启 CORS）。

## 账户使用说明（给成员）

1. 打开网址 → 用管理员分配的账户名 + 初始密码登录；
2. 右上角「设置 → 账户与密码 → 修改密码」，首次登录后建议立即修改；
3. 任务列表、排序、处置决策等操作与原版完全一致，数据仅本账户可见；
4. 右上角「⎋」退出登录。

## 测试

```bash
node test/api.test.js     # 11 项：登录/隔离/乐观锁/改密/登出/静态
npm i --save-dev jsdom && node test/dom.test.js   # 4 项：登录→加载→保存→登出
```

评分模型单测仍沿用 `public/scoring.js`（与网页版同一实现）。

## 目录结构

```
task-priority-server/
├── server.js            # HTTP 服务 + JSON API + 静态前端
├── db.js                # SQLite 存储（账户 + 任务 + 乐观锁）
├── auth.js              # scrypt 密码散列 + 会话
├── reset-password.js    # 重置账户密码
├── public/              # 前端（多账户版，登录界面 + 服务端同步）
├── data/                # 运行时生成：tasks.db、初始密码.txt
└── test/                # API 集成测试 + DOM 冒烟测试
```
