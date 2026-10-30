# DEPLOYMENT — host PulsarChat on a Bluehost VPS with your Cloudflare domain

Goal: anybody in the world opens `https://yourdomain.com` and can use the app (ghost rooms and permanent rooms).

> **Placeholders to replace everywhere**
> `yourdomain.com` → your real domain (a subdomain such as `chat.yourdomain.com` works the same)
> `YOUR_SERVER_IP` → the public IP shown in your Bluehost portal
> The repo in this guide is your fork: `https://github.com/GSpo7/pulsarchat`

> **Status of the code:** the app code (including permanent rooms) is on the branch `feature/permanent-rooms`. Merge it into `main` on GitHub (Part 1, step 4) before you deploy, because the server pulls `main`.

---

## Quick answer: what to choose when buying the Bluehost VPS

On the Bluehost checkout, the **Software** section has three tabs. Choose:

| Tab | Choose? | Why |
|---|---|---|
| **Plain OS** | ✅ **Yes → Ubuntu Server 24.04 LTS** | A clean Linux box you control. This guide's commands are written for Ubuntu 24.04. |
| OS With Panel (cPanel, etc.) | ❌ No | cPanel is a hosting control panel for websites/email. It would run its own web server on ports 80/443, use RAM, cost an extra monthly licence, and fight with our setup. We don't need it: Cloudflare handles the domain and HTTPS. |
| Application (WordPress, n8n, LAMP, Portainer, …) | ❌ No | These pre-install software we don't use. PulsarChat is a Node.js app; you install it yourself in Part 5. |

Other choices on the page
- **Plan size**: choose a plan with **at least 2 GB RAM and 2 vCPU** (check the specs in the *Configure* tab; Bluehost's plans are labelled NVMe 2 / 4 / 8 / 16, and I couldn't confirm their exact RAM from here — read the numbers on the page). If you can only get 1 GB, it still works if you add the swap file in Part 4.
- **Location**: the data centre closest to most of your users. All chat traffic ends at this one server; Cloudflare only speeds up the website's static files and the TLS handshake.
- **Add-ons**: Support/Premium Support is optional. Do **not** buy extra IP addresses; one is enough.
- **Domain**: skip any "free domain / domain bundle" offer — your domain already lives on Cloudflare.
- **Version**: Ubuntu **24.04** (Bluehost also lists 22.04, 25.04, 25.10, 26.04). 24.04 is a long-term-support release that Node.js and Cloudflare's tools support well.

Note: Bluehost's support covers the server itself; the Cloudflare Tunnel and this app are outside what they'll help with, which is why this guide is detailed.

---

## How it works (60-second version)

```
Visitor's browser ──HTTPS──► Cloudflare (DNS, TLS certificate, DDoS shield)
                                   │  encrypted outbound tunnel (cloudflared)
                                   ▼
                        Your Bluehost VPS (Ubuntu) — no web ports open to the internet
                          └─ Node server on 127.0.0.1:9000
                               ├─ website files (dist/)
                               ├─ /peerjs     ghost-room signalling
                               ├─ /notify     pings
                               ├─ /permanent  permanent rooms (WebSocket)
                               ├─ /api/health health check
                               └─ SQLite database file  ← back this up
```
- The VPS **dials out** to Cloudflare. You never open port 80/443 and never manage certificates.
- One address serves everything, so there is no CORS to configure.

Cost: your Bluehost VPS plan. Everything else used here is free.

---

## Part 1 — Prepare accounts and files (≈ 20 min)

1. **Cloudflare**: your domain must show **Active** (dashboard → your domain). If it says "Pending nameserver update", finish the nameserver change at your registrar first.
2. **Your SSH key (important — read this).** I noticed files named `sshkey` and `sshkey.pub` in your project folder.
   - `sshkey` is your **private** key. It must **never** be committed to GitHub or shared. (I added both names to `.gitignore` so git will refuse to track them, but still move them.)
   - Move them to your SSH folder and lock permissions. In **PowerShell**:
     ```powershell
     New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh" | Out-Null
     Move-Item "C:\Users\ghanny.adenekan\workspace\pulsarchat\sshkey*" "$env:USERPROFILE\.ssh\"
     icacls "$env:USERPROFILE\.ssh\sshkey" /inheritance:r /grant:r "$($env:USERNAME):(R)"
     ```
     (The `icacls` line prevents Windows' "UNPROTECTED PRIVATE KEY FILE" error.)
   - Print the **public** key (safe to share; you'll paste it onto the server in Part 3):
     ```powershell
     Get-Content "$env:USERPROFILE\.ssh\sshkey.pub"
     ```
   - If you ever suspect `sshkey` was copied or pushed anywhere, generate a new one with `ssh-keygen -t ed25519` and replace it on the server.
3. **TURN credentials** — you have these. You'll put them in a file on the server in Part 5. (TURN is the relay that lets ghost-room WebRTC connections work across mobile networks and strict firewalls.)
4. **Get the code onto `main` in your fork** (`GSpo7/pulsarchat`). On your PC, in the project folder:
   ```powershell
   git add -A
   git commit -m "Add permanent rooms and self-hosting support"   # sshkey files are ignored
   git push -u origin feature/permanent-rooms
   ```
   Then on GitHub open a pull request `feature/permanent-rooms → main` and merge it (or ask Claude to do the commit for you).
5. **Repository visibility (licence):** PulsarChat is AGPL-3.0, which requires you to offer your site's source code to its users. Keep your fork **public** (GitHub → repo → Settings → Danger zone → visibility). If you must keep it private, tell me and we'll adjust, because the server also needs a way to clone it (Part 5).
6. *(Optional)* **Web3Forms** key for the feedback form: https://web3forms.com

---

## Part 2 — Create the Bluehost VPS (≈ 15 min)

1. Bluehost → **Hosting/Servers → VPS → Self-Managed VPS** → pick a plan → **Choose Plan**.
2. **Location** and **Hardware** as described above (2 GB RAM or more).
3. **Software** → **Plain OS** tab → **Ubuntu 24.04**.
4. Add-ons as you like → pick a billing term → **Continue to Checkout** → create your account → pay.
5. When provisioning finishes, open the **Hosting** tab → **Manage** → **View Details**. Note:
   - the **IP address** (`YOUR_SERVER_IP`),
   - how Bluehost gives you the initial login (a root password, which you can reset there with the **reset root password** feature, and/or an SSH key you added during setup).
6. **First login** from PowerShell. Use whichever matches how your server was set up:
   ```powershell
   # if you registered your key with Bluehost:
   ssh -i "$env:USERPROFILE\.ssh\sshkey" root@YOUR_SERVER_IP
   # if you were given a root password instead:
   ssh root@YOUR_SERVER_IP
   ```
   Type `yes` for the fingerprint question.
7. **If SSH won't connect:** use the **Launch Console** button in the Bluehost portal. It gives you a terminal in the browser; every command in this guide works there too.

---

## Part 3 — Secure the server (≈ 15 min)

Run as `root` on the server.

```bash
# 1. Update everything
apt update && apt -y upgrade

# 2. Create an admin user (choose a strong password when asked; keep it, you'll need it for sudo)
adduser deploy
usermod -aG sudo deploy

# 3. Put your PUBLIC key on that user (works no matter how you logged in as root)
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
nano /home/deploy/.ssh/authorized_keys
```
In nano, paste the **one line** from `Get-Content ...sshkey.pub` (starts with `ssh-ed25519` or `ssh-rsa`), then Ctrl+O, Enter, Ctrl+X.
```bash
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

# 4. Firewall: ONLY ssh is reachable. Web traffic arrives through the tunnel, not through open ports.
apt -y install ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable
ufw status

# 5. Automatic security updates + brute-force protection
apt -y install unattended-upgrades fail2ban
dpkg-reconfigure -plow unattended-upgrades   # answer Yes
systemctl enable --now fail2ban
```
If the Bluehost portal also shows a **firewall / security group** for the server, allow only SSH (port 22). You do **not** need ports 80 or 443.

**Open a second PowerShell window** and prove the new login works *before* locking anything down:
```powershell
ssh -i "$env:USERPROFILE\.ssh\sshkey" deploy@YOUR_SERVER_IP
sudo whoami      # should print: root
```
Only when that works, back in the root session, disable password and root logins:
```bash
cat >/etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
EOF
systemctl restart ssh
```
From now on log in as `deploy` only. (Tip: create `C:\Users\ghanny.adenekan\.ssh\config` with
```
Host pulsar
  HostName YOUR_SERVER_IP
  User deploy
  IdentityFile ~/.ssh/sshkey
```
and you can simply type `ssh pulsar`.)

---

## Part 4 — Install Node.js and tools (≈ 10 min)

As `deploy`:

```bash
sudo apt -y install git curl build-essential python3 sqlite3

# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs
node -v && npm -v
```

*Only if your server has 1 GB RAM* — add swap so the build doesn't get killed:
```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Create the service account and folders:
```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin pulsarchat
sudo mkdir -p /opt/pulsarchat /var/lib/pulsarchat
sudo chown deploy:deploy /opt/pulsarchat
sudo chown pulsarchat:pulsarchat /var/lib/pulsarchat
sudo chmod 700 /var/lib/pulsarchat
```
`/opt/pulsarchat` holds the code (owned by you). `/var/lib/pulsarchat` holds the database (owned only by the service account).

---

## Part 5 — Get the code, configure, build, run (≈ 20 min)

### 5.1 Clone
```bash
git clone https://github.com/GSpo7/pulsarchat.git /opt/pulsarchat
cd /opt/pulsarchat
git log --oneline -3        # confirm the permanent-rooms commit is on main
```
(If the repo is private, create a GitHub *deploy key* or a read-only fine-grained token and clone with that. Public is simplest and satisfies the AGPL.)

### 5.2 Build-time settings (browser side)
These values are baked into the website files when you build. Create `/opt/pulsarchat/.env` (git-ignored):
```bash
nano /opt/pulsarchat/.env
```
Paste, then edit the values (your TURN username/credential go here):
```
VITE_SERVER_URL=https://yourdomain.com
VITE_APP_URL=https://yourdomain.com
VITE_SOURCE_URL=https://github.com/GSpo7/pulsarchat
VITE_TURN_URL=turn:free.expressturn.com:3478
VITE_TURN_USERNAME=your_turn_username
VITE_TURN_CREDENTIAL=your_turn_credential
VITE_WEB3FORMS_KEY=your_web3forms_key
```
Save: Ctrl+O, Enter. Exit: Ctrl+X. (Skip `VITE_WEB3FORMS_KEY` if you aren't using the feedback form.)
Note: TURN credentials in a browser app are visible to anyone who inspects the site. That is normal for free relay services; just use credentials meant for this.

### 5.2b Runtime settings (server side)
Create `/etc/pulsarchat.env` — readable only by root and the service account:
```bash
sudo tee /etc/pulsarchat.env >/dev/null <<'EOF'
NODE_ENV=production
HOST=127.0.0.1
PORT=9000
TRUST_PROXY=true
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
DATABASE_PATH=/var/lib/pulsarchat/pulsar.db
STATS_SECRET=CHANGE_ME
EOF
sudo sed -i "s/STATS_SECRET=CHANGE_ME/STATS_SECRET=$(openssl rand -hex 24)/" /etc/pulsarchat.env
sudo chown root:pulsarchat /etc/pulsarchat.env
sudo chmod 640 /etc/pulsarchat.env
sudo cat /etc/pulsarchat.env      # check it; note your STATS_SECRET
```
`HOST=127.0.0.1` + `TRUST_PROXY=true` are safe **only because** the app is reachable solely through the tunnel; never expose port 9000 publicly. `NODE_ENV=production` is required (it turns on strict origin checking).

### 5.3 Install and build
```bash
cd /opt/pulsarchat
npm ci
npm test            # optional but recommended: should say "pass 30, fail 0"
npm run build
ls dist             # you should see index.html and an assets/ folder
```

### 5.4 Test run (foreground)
```bash
sudo -u pulsarchat env $(sudo cat /etc/pulsarchat.env | xargs) node server.js
```
It should print `PulsarChat server running on 127.0.0.1:9000`. In a second SSH window: `curl -i http://127.0.0.1:9000/api/health` → expect `200` and `{"ok":true}`. Stop the server with Ctrl+C.

### 5.5 Run it forever with systemd
```bash
sudo tee /etc/systemd/system/pulsarchat.service >/dev/null <<'EOF'
[Unit]
Description=PulsarChat server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pulsarchat
Group=pulsarchat
WorkingDirectory=/opt/pulsarchat
EnvironmentFile=/etc/pulsarchat.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/pulsarchat

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now pulsarchat
sudo systemctl status pulsarchat --no-pager
curl -i http://127.0.0.1:9000/api/health
sudo ss -tlnp | grep 9000      # must show 127.0.0.1:9000, NOT 0.0.0.0:9000
ls -l /var/lib/pulsarchat      # pulsar.db should now exist
```
Logs: `sudo journalctl -u pulsarchat -f`.

---

## Part 6 — Connect the domain with a Cloudflare Tunnel (≈ 15 min)

All on the server as `deploy`. Requires outbound internet from the server to Cloudflare (port 7844); Bluehost VPSes allow outbound traffic by default.

### 6.1 Install cloudflared
```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
cloudflared --version
```

### 6.2 Log in
```bash
cloudflared tunnel login
```
It prints a URL. Open it **in the browser on your PC**, choose **yourdomain.com**, click **Authorize**. The server saves a certificate to `~/.cloudflared/cert.pem` (treat it like a password).

### 6.3 Create the tunnel
```bash
cloudflared tunnel create pulsarchat
```
Note the **Tunnel ID (a UUID)** and the credentials file path it prints (`/home/deploy/.cloudflared/<UUID>.json`).

### 6.4 Configure it
```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<UUID>.json /etc/cloudflared/<UUID>.json
sudo nano /etc/cloudflared/config.yml
```
Paste (replace both `<UUID>` and the domain):
```yaml
tunnel: <UUID>
credentials-file: /etc/cloudflared/<UUID>.json

ingress:
  - hostname: yourdomain.com
    service: http://127.0.0.1:9000
  - hostname: www.yourdomain.com
    service: http://127.0.0.1:9000
  - service: http_status:404
```
The last rule (404) is required.

### 6.5 Create the DNS records
```bash
cloudflared tunnel route dns pulsarchat yourdomain.com
cloudflared tunnel route dns pulsarchat www.yourdomain.com
```
If it complains a record already exists, open Cloudflare → your domain → **DNS → Records**, delete the old `A`/`AAAA`/`CNAME` for that name (for example one pointing to a previous host), then run the command again. You should end up with proxied (orange cloud) `CNAME` records pointing at `<UUID>.cfargotunnel.com`.

### 6.6 Run the tunnel as a service
```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared --no-pager
cloudflared tunnel info pulsarchat      # should list an active connector
```
If the service starts but can't find its config, confirm that `/etc/cloudflared/config.yml` exists and its `credentials-file` path is correct.

---

## Part 7 — Cloudflare dashboard settings (≈ 10 min)

Cloudflare menu names change occasionally; use the search box if you can't find an item.

1. **SSL/TLS → Overview**: set encryption mode to **Full (strict)**.
2. **SSL/TLS → Edge Certificates**: turn on **Always Use HTTPS**; set **Minimum TLS Version** to **1.2**.
3. **Network**: **WebSockets = On** (default). Cloudflare closes idle WebSockets after ~100 s; the app sends keep-alive pings every 25 s.
4. **Speed → Optimization**: make sure **Rocket Loader is Off** (it can break React apps).
5. **Caching → Cache Rules**: create a rule — *If* URI Path starts with `/peerjs`, `/notify`, `/permanent`, or `/api` → **Bypass cache**.
6. **Security → Settings**: leave **Bot Fight Mode off** until after your first successful tests; if you enable it later and chat connections fail, turn it off again.
7. **Security → WAF → Rate limiting rules** (if your plan includes one): path starts with `/permanent`, more than 60 requests per 10 s per IP → block for 10 min. The app has its own limits too; this is a second layer.
8. *(Optional)* **DNS → Settings → DNSSEC**: enable.

---

## Part 8 — Go-live test (≈ 10 min)

1. From your PC:
   ```powershell
   curl.exe -i https://yourdomain.com/api/health
   ```
   Expect `HTTP/2 200`. Open `https://yourdomain.com` — the lobby loads with a padlock and a **permanent rooms** button.
2. **Ghost room across networks:** on your PC create a room; on your phone, **turn Wi-Fi off (mobile data)**, open the site and join with the code. Messages must flow both ways. If this fails only on mobile data, your TURN credentials are wrong (see troubleshooting).
3. **Permanent room:** on your PC tap *permanent rooms* → *generate* → *open room* → send a message. On your phone (mobile data) open the site → *permanent rooms* → enter the same code (or use *copy invite link* and open that link) → you should see the message. Reply from the phone; it should appear on the PC instantly.
4. **Persistence:** close both browsers, reopen the site, tap the saved room (or re-enter the code) → full history is still there. Then restart the server (`sudo systemctl restart pulsarchat`) and reopen: still there.
5. Check contacts/ping and saved chats still work.
6. Watch `sudo journalctl -u pulsarchat -f` while testing: no errors, no `rejected upgrade` lines.
7. Ask someone in another country/network to open the link — that's the "accessible worldwide" proof.

---

## Part 9 — Backups (do this before real users arrive)

A permanent chat without a backup is not permanent. Backups contain only ciphertext, so they are safe to store off-server. (Do **not** back up by copying `pulsar.db` while the server runs — the database uses a write-ahead log; the script below uses SQLite's safe online backup.)

### 9.1 Create an R2 bucket and key
1. Cloudflare dashboard → **R2 Object Storage** → enable (free tier; a payment method may be requested).
2. **Create bucket** → name `pulsarchat-backups` (keep it private).
3. **Manage API tokens → Create API token** → permission **Object Read & Write**, scope **only that bucket**. Save the **Access Key ID**, **Secret Access Key** and your **Account ID** (the S3 endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).

### 9.2 Install rclone and configure
```bash
sudo apt -y install rclone
sudo tee /etc/pulsarchat-rclone.conf >/dev/null <<'EOF'
[r2]
type = s3
provider = Cloudflare
access_key_id = YOUR_ACCESS_KEY_ID
secret_access_key = YOUR_SECRET_ACCESS_KEY
endpoint = https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
EOF
sudo chmod 600 /etc/pulsarchat-rclone.conf
```
`no_check_bucket = true` is required with a bucket-scoped token: without it rclone tries to create/check the bucket first and R2 answers `AccessDenied`. If you chose an EU jurisdiction for the bucket, the endpoint is `https://YOUR_ACCOUNT_ID.eu.r2.cloudflarestorage.com`.

If the upload still says `AccessDenied`: the token's permission must be **Object Read & Write** (not Read only) and its scope must include the `pulsarchat-backups` bucket; check with `rclone --config /etc/pulsarchat-rclone.conf lsd r2:` (a bucket-scoped token may list nothing — that is fine) and `rclone --config /etc/pulsarchat-rclone.conf ls r2:pulsarchat-backups`. A wrong key gives `InvalidAccessKeyId`/`SignatureDoesNotMatch` instead.

### 9.3 Backup script
```bash
sudo tee /usr/local/bin/pulsarchat-backup.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
DB=/var/lib/pulsarchat/pulsar.db
OUT=/var/backups/pulsarchat
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 700 -o pulsarchat -g pulsarchat "$OUT"
# consistent online snapshot, safe while the server is running
runuser -u pulsarchat -- sqlite3 "$DB" ".backup '$OUT/pulsar.db'"
gzip -9 -c "$OUT/pulsar.db" > "$OUT/pulsar-$STAMP.db.gz"
rm -f "$OUT/pulsar.db"
rclone --config /etc/pulsarchat-rclone.conf copyto "$OUT/pulsar-$STAMP.db.gz" "r2:pulsarchat-backups/pulsar-$STAMP.db.gz"
rclone --config /etc/pulsarchat-rclone.conf delete r2:pulsarchat-backups --min-age 30d
find "$OUT" -name 'pulsar-*.db.gz' -mtime +3 -delete
echo "backup ok $STAMP"
EOF
sudo chmod 750 /usr/local/bin/pulsarchat-backup.sh
sudo /usr/local/bin/pulsarchat-backup.sh      # run once by hand; expect "backup ok"
echo '17 3 * * * root /usr/local/bin/pulsarchat-backup.sh >> /var/log/pulsarchat-backup.log 2>&1' | sudo tee /etc/cron.d/pulsarchat-backup
```
Also consider enabling Bluehost's own server backups/snapshots if they offer them — a second, independent copy.

### 9.4 Restore drill — practise this once
```bash
sudo systemctl stop pulsarchat
rclone --config /etc/pulsarchat-rclone.conf ls r2:pulsarchat-backups
rclone --config /etc/pulsarchat-rclone.conf copyto r2:pulsarchat-backups/pulsar-<STAMP>.db.gz /tmp/restore.db.gz
gunzip -f /tmp/restore.db.gz
sudo rm -f /var/lib/pulsarchat/pulsar.db-wal /var/lib/pulsarchat/pulsar.db-shm
sudo install -m 600 -o pulsarchat -g pulsarchat /tmp/restore.db /var/lib/pulsarchat/pulsar.db
sudo systemctl start pulsarchat
```
(If a restore is older than what some users have seen, their open browsers automatically reload the room from the server's version.)

---

## Part 10 — Deploying updates

The script is already in the repo as `scripts/deploy.sh`.

Workflow: develop on a branch → merge to `main` on GitHub → SSH in → run:
```bash
/opt/pulsarchat/scripts/deploy.sh
```
Notes
- A restart disconnects everyone for a couple of seconds. Permanent-room clients reconnect and catch up automatically; in-progress ghost rooms may need to be re-created. Deploy at quiet times.
- Run a manual backup (`sudo /usr/local/bin/pulsarchat-backup.sh`) before any deploy that changes the database schema.
- Never edit files directly on the server; always change → commit → deploy.
- *(Optional later)* automate with a GitHub Actions workflow that SSHes in and runs the script.

---

## Part 11 — Operating permanent rooms

The server never has the room codes, so rooms appear as hashes.

```bash
cd /opt/pulsarchat
# list rooms (hash, message count, size, created) — never content
sudo -u pulsarchat DATABASE_PATH=/var/lib/pulsarchat/pulsar.db node scripts/purge-room.js --list

# permanently delete one room (e.g. on a removal request: the requester gives you the code)
sudo -u pulsarchat DATABASE_PATH=/var/lib/pulsarchat/pulsar.db node scripts/purge-room.js --code "the room code"
```
It asks you to type `DELETE` to confirm. Deletion is permanent (restore from backup if it was a mistake).

Limits you can tune in `/etc/pulsarchat.env` (then `sudo systemctl restart pulsarchat`): `ROOM_MAX_BYTES`, `MAX_TEXT_BYTES`, `MAX_IMAGE_BYTES`, `MAX_AUDIO_BYTES`, `PAGE_MAX_BYTES`, `MIN_FREE_DISK_BYTES`, `SOCKET_MESSAGES_PER_10S`, `CONNECTIONS_PER_MINUTE_PER_IP`, `NEW_ROOMS_PER_HOUR_PER_IP` (defaults are listed in `.env.example`).

---

## Part 12 — Monitoring

- **Uptime alert**: free account at UptimeRobot (or Better Stack) → HTTPS monitor on `https://yourdomain.com/api/health`, 5-minute interval, email alerts.
- **Disk**: `df -h /var/lib/pulsarchat` monthly. The app refuses *new* rooms below the free-space watermark but never deletes anything — upgrade the plan/disk before it fills.
- **Logs**: `sudo journalctl -u pulsarchat --since "1 hour ago"`, `sudo journalctl -u cloudflared --since today`. Application logs contain counts and error codes only, never codes or messages.
- **Stats**: `curl "https://yourdomain.com/stats?key=YOUR_STATS_SECRET"` (active ghost users and permanent-room connections).
- **OS updates**: unattended security updates are on; about monthly run `sudo apt update && sudo apt upgrade` and `sudo reboot` (both services start automatically).

---

## Part 13 — Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| Cloudflare **Error 1033** / "Argo Tunnel error" | `cloudflared` isn't running → `sudo systemctl status cloudflared`, check `/etc/cloudflared/config.yml` UUID and credentials path |
| **502 Bad Gateway** | Node isn't running or port differs → `sudo systemctl status pulsarchat`; `curl http://127.0.0.1:9000/api/health`; confirm `service:` port in config.yml |
| Site loads but chat never connects | Origin rejected → `journalctl -u pulsarchat` shows `rejected upgrade`; fix `ALLOWED_ORIGINS` (exact `https://` origins, no trailing slash; include `www.` if you use it) and make sure `NODE_ENV=production` is set; restart |
| Permanent room says "server address is not configured" | `VITE_SERVER_URL` was missing at build time → set it in `/opt/pulsarchat/.env`, rebuild (`npm run build`), restart |
| "Too many connections" for everyone | `TRUST_PROXY` isn't `true`, so all users look like one IP |
| Ghost rooms work on Wi-Fi, fail on mobile data | TURN credentials missing/wrong in `/opt/pulsarchat/.env` → fix, **rebuild**, restart |
| Blank page / old settings after editing `.env` | `VITE_*` values are compiled in → `npm run build` again |
| "Permanent rooms need HTTPS" / "E2EE requires HTTPS" | You opened the site over plain HTTP or by IP; use `https://yourdomain.com` |
| Chat drops every ~100 s | Keep-alive pings blocked → check Cloudflare WebSockets is On |
| `SQLITE_CANTOPEN` / "readonly database" | Permissions → `sudo chown -R pulsarchat:pulsarchat /var/lib/pulsarchat`; make sure `ReadWritePaths=/var/lib/pulsarchat` is in the unit file |
| `npm ci` fails building `better-sqlite3` | `sudo apt -y install build-essential python3`; make sure Node is 22 LTS |
| Build killed ("Killed" / exit 137) | Out of RAM → add the swap file from Part 4 |
| `cloudflared tunnel login` prints a URL but never finishes | Open the URL on your PC, not on the server; make sure you pick the right domain |
| Tunnel can't connect ("failed to dial") | Outbound port 7844 blocked → check any Bluehost-side firewall for outbound rules |
| Can't SSH after hardening | Use **Launch Console** in the Bluehost portal and revert `/etc/ssh/sshd_config.d/99-hardening.conf` |
| `UNPROTECTED PRIVATE KEY FILE` on Windows | Run the `icacls` command from Part 1, step 2 |
| DNS record conflict when routing the tunnel | Delete the old A/AAAA/CNAME record for that hostname in Cloudflare DNS, rerun `route dns` |

---

## Final go-live checklist

- [ ] Bluehost VPS: **Plain OS → Ubuntu 24.04**, ≥ 2 GB RAM (or swap added)
- [ ] `sshkey` moved out of the project folder; never committed
- [ ] Domain Active in Cloudflare; `https://yourdomain.com` loads with padlock
- [ ] `ufw status` shows only OpenSSH; `ss -tlnp` shows Node on 127.0.0.1 only
- [ ] Root SSH and password SSH disabled; unattended-upgrades on
- [ ] `pulsarchat` and `cloudflared` services enabled (survive reboot — test with `sudo reboot`)
- [ ] Ghost room works across two different networks including mobile data
- [ ] Permanent room: message sent on one device appears on another and survives a server restart
- [ ] `/etc/pulsarchat.env` has a real `STATS_SECRET`; no secrets committed to git
- [ ] Nightly backup ran at least once; restore drill done
- [ ] Uptime monitor active
- [ ] Footer/source link points to **your** public fork (AGPL)
- [ ] Legal page has a way for people to contact you (it mentions the operator) — add your contact email if you want one
