# 部署到服务器 · 新手保姆指南

> 目标：让 `task-priority-server` 这个 Node 程序在**一台常开的服务器**上运行，获得一个**公网 HTTPS 网址**，5 位成员各自登录使用。
>
> 整个程序**零第三方依赖**（只用 Node 自带的库），所以部署只要满足：**装了 Node ≥ 22.5** 即可。

## 先想清楚两件事

1. **预算与地点**：海外免费平台（Render/Railway）最简单、自动 HTTPS、不用备案，但访问稍慢、免费档有数据限制；国内云服务器（阿里云/腾讯云）快、稳、数据在国内，但要实名购买 + 域名备案才能上 HTTPS。
2. **数据持久化**：SQLite 数据库文件必须放在**持久磁盘**上，否则服务器重启数据会丢。

下面按"从易到难"给出三条路线，**新手建议先走路线 A**。

---

## 路线 A：Render（海外，免费起步，最简单，全程网页点几下）

1. 注册 https://render.com（GitHub 账号一键登录即可）；
2. 先把你本机的代码推到 GitHub（可参照之前 GitHub Pages 的做法，把 `task-priority-server` 整个目录传上去）；
3. Render 控制台 → **New → Web Service** → 连接你的 GitHub 仓库；
4. 关键配置：
   - **Build Command**：留空（无需安装依赖）
   - **Start Command**：`node server.js`
   - **Environment**：Node
   - 添加环境变量：`ACCOUNTS` = `张三,李四,王五,赵六,孙七`（5 个账户名）
5. 点 **Create Web Service**，等 1–2 分钟，得到一个 `https://xxx.onrender.com` 网址，发给成员即可。

> ⚠️ **数据持久化**：Render 免费实例的磁盘在**重新部署时会被清空**（任务数据会丢）。要长期可靠，请升级为付费实例并挂载 **Persistent Disk**（在 Web Service 的 Disks 里添加，把挂载路径如 `/data` 配到环境变量 `DATA_DIR=/data`，约 $0.25/GB/月）。

---

## 路线 B：Railway（海外，比 Render 稳，有持久盘，约 $5/月）

1. 注册 https://railway.app（GitHub 登录）；
2. **New Project → Deploy from GitHub repo** → 选你的仓库；
3. 服务会自动识别 Node；把 Start Command 设为 `node server.js`；
4. 加环境变量 `ACCOUNTS=张三,李四,王五,赵六,孙七`；
5. **添加 Volume（数据卷）**：项目里点服务 → **Volumes → Add**，挂载路径填 `/data`，再加环境变量 `DATA_DIR=/data`；
6. Railway 自动给 HTTPS 域名，把网址发给成员。

> Railway 提供 30 天/一次性体验额度，之后约 $5/月，含持久盘，是目前"新手 + 数据可靠"的最省心选择。

---

## 路线 C：国内云服务器（阿里云/腾讯云，数据在国内，需实名+备案）

适合：团队要求数据不出境、访问快、长期自用。

### 第 1 步：买服务器

- 阿里云/腾讯云「**轻量应用服务器**」，2 核 2G 即可，选 **Ubuntu 22.04/24.04**，新用户约 100 元/年；
- 记下公网 IP、用户名 `root`、密码；在控制台「安全组/防火墙」**放行端口 8788**（或你选的端口）。

### 第 2 步：装 Node（SSH 登录后执行）

```bash
# 用 nvm 装 Node 24（最省心）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 24
node -v        # 应显示 v24.x
```

### 第 3 步：上传代码

在你自己电脑上执行（`/Users/haoyanqian/Documents/dsh` 目录下）：

```bash
# 排除 node_modules 和数据目录，打包上传
cd /Users/haoyanqian/Documents/dsh
tar --exclude='task-priority-server/node_modules' \
    --exclude='task-priority-server/data' \
    -czf tp-server.tar.gz task-priority-server
scp tp-server.tar.gz root@你的服务器IP:/root/
```

回到服务器 SSH 里：

```bash
cd /root && tar xzf tp-server.tar.gz && cd task-priority-server
ACCOUNTS="张三,李四,王五,赵六,孙七" node server.js
# 控制台会打印 5 个账户的初始密码，请记下并分发
```

此时用手机浏览器打开 `http://你的服务器IP:8788` 应能登录使用。

### 第 4 步：让程序常驻 + 开机自启（pm2）

```bash
npm i -g pm2
cd /root/task-priority-server
ACCOUNTS="张三,李四,王五,赵六,孙七" pm2 start ecosystem.config.js
pm2 save && pm2 startup   # 开机自启（按提示复制执行最后一行命令）
```

### 第 5 步（重要）：上 HTTPS

用密码登录，必须走 HTTPS，否则密码在网络上明文传输。两条路二选一：

- **有域名**：给域名备案（腾讯云/阿里云控制台有引导，约 1–3 周）→ 用 nginx + certbot 挂证书（我可给完整命令）；
- **不想备案/没域名**：改用**海外服务器**（路线 A/B），或把服务器放在香港节点（免备案）再用 Cloudflare 挂免费证书。

> 说明：中国大陆服务器上用域名跑 HTTP/HTTPS 必须 ICP 备案，这是政策要求，无法绕过。

---

## 我要不要帮你做？

部署这件事我可以**直接代劳**，你只需提供其一：

1. **路线 A/B**：把 Render 或 Railway 账号登录后，把仓库授权给我（或给我一个平台 Token）；
2. **路线 C**：把服务器的 **公网 IP + root 密码**（或 SSH 密钥）给我，我帮你装 Node、传代码、配 pm2、启动并验证。

提供后我会：部署 → 生成 5 个账户初始密码 → 给你可用的网址 → 验证登录。

---

## 部署后常见问题

- **改代码后如何更新？** 重传代码 + `pm2 restart task-priority`（路线 C）；Render/Railway 推送到 GitHub 会自动重新部署。
- **账户密码忘了？** 服务器上执行 `node reset-password.js <账户名>` 即可重置并打印新密码。
- **换 5 个账户名单？** 改启动时的 `ACCOUNTS` 环境变量，重启即可（新增账户首次启动自动生成密码，已有账户不受影响）。
- **数据备份？** 备份服务器上的 `data/tasks.db` 文件即可（前端也可逐个账户导出 JSON）。
