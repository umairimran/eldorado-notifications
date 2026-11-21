# Deploy to a VPS (Ubuntu 22.04 / 24.04)

The VPS runs the listener 24/7 and auto-restarts it on crashes and reboots. You open the page from your PC through an encrypted SSH tunnel, so the page is **never public**. It has no password, and anyone who can reach it could see buyer names and switch auto-offer on/off.

> ⚠️ **Run only ONE copy.** Stop the listener on your PC (Ctrl+C in its terminal) before starting it on the VPS, or both will try to send offers.

## 0. What you need

- A VPS: Ubuntu 22.04 or 24.04, 1 vCPU / 1 GB RAM is plenty. A US-East or EU region keeps latency low.
- The VPS IP address and root (or sudo) SSH login. Below, `1.2.3.4` stands for your IP.

## 1. Pack the project on your PC (PowerShell)

From the `Aldo Bot` folder:

```powershell
tar -czf eldorado.tgz --exclude=node_modules --exclude=dist eldorado-notifications
```

This includes `.env` (credentials) and `.state/` (seen notifications, already-offered requests, your page settings), so the VPS continues exactly where your PC stopped.

## 2. Copy it to the VPS

```powershell
scp eldorado.tgz root@1.2.3.4:/root/
```

## 3. Install on the VPS

```powershell
ssh root@1.2.3.4
```

Then on the VPS:

```bash
# system + Node.js 22
apt update && apt -y upgrade
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource.sh && bash /tmp/nodesource.sh
apt -y install nodejs
node --version            # must be v22 or newer

# dedicated user + files
useradd --system --home /opt/eldorado-notifications --shell /usr/sbin/nologin eldorado
tar -xzf /root/eldorado.tgz -C /opt
cd /opt/eldorado-notifications
npm ci
npm run build
npm test                  # all tests should pass
mkdir -p .state
chown -R eldorado:eldorado /opt/eldorado-notifications
chmod 600 .env

# check credentials + API from the VPS
sudo -u eldorado node dist/src/index.js --verify
```

## 4. Run it as a service (24/7, auto-restart)

```bash
cp deploy/eldorado.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now eldorado
journalctl -u eldorado -f     # live logs (Ctrl+C to stop watching; the service keeps running)
```

## 5. Firewall: only SSH open

```bash
ufw allow OpenSSH
ufw enable
```

Do **not** open port 3000.

## 6. Open the page from your PC (SSH tunnel)

Keep this running in a PowerShell window:

```powershell
ssh -N -L 3000:127.0.0.1:3000 root@1.2.3.4
```

Then open **http://127.0.0.1:3000** in your browser. It's the same page and Auto-offer panel, now served from the VPS. Close the window to close the tunnel; the bot keeps running on the VPS.

## Everyday commands (on the VPS)

| What | Command |
|---|---|
| Status | `systemctl status eldorado` |
| Live logs | `journalctl -u eldorado -f` |
| Last 200 log lines | `journalctl -u eldorado -n 200` |
| Restart | `systemctl restart eldorado` |
| Stop | `systemctl stop eldorado` |
| Start | `systemctl start eldorado` |
| Don't start on boot | `systemctl disable eldorado` |

## Updating the code later

On your PC: repeat steps 1-2. Then on the VPS:

```bash
systemctl stop eldorado
cd /opt && tar -xzf /root/eldorado.tgz --exclude='eldorado-notifications/.state' --exclude='eldorado-notifications/.env'
cd /opt/eldorado-notifications && npm ci && npm run build && chown -R eldorado:eldorado .
systemctl start eldorado
```

(The excludes keep the VPS's own `.state` and `.env`.)

## Security checklist

- Use SSH keys and disable password login if your provider allows it.
- `.env` is `chmod 600` and owned by the service user.
- Your Client secret was pasted in a chat earlier: generate a new credential on Eldorado's Seller API page, put it in `/opt/eldorado-notifications/.env`, `systemctl restart eldorado`, then revoke the old one.
- VPS clocks are NTP-synced (check with `timedatectl`), so the page's "event age" will be accurate there.
