/**
 * blitz-sbx - a clean, small VLESS+WS node for Blitz (and any Node PaaS).
 *
 * How it works:
 *  - A plain HTTP server listens on $PORT (Blitz default 8080) for health checks.
 *  - At startup it downloads sing-box and cloudflared (linux amd64) into ./bin,
 *    writes a sing-box config from env vars, and runs both.
 *  - sing-box listens only on 127.0.0.1:SBX_PORT with VLESS+WS at WS_PATH.
 *  - cloudflared connects outbound with ARGO_AUTH and serves ARGO_DOMAIN,
 *    so the fixed tunnel hostname is the only public entry point.
 *  - Nezha agent is optional: set NEZHA_SERVER and NEZHA_KEY to enable it.
 *
 * Env vars (set in the Blitz dashboard, never in this repo):
 *  UUID         - VLESS user id (required for a stable node link)
 *  NAME         - node display name, default "blitz"
 *  WS_PATH      - WebSocket path, default "/blitz-ws"
 *  SBX_PORT     - sing-box local port, default 18000
 *  ARGO_DOMAIN  - fixed tunnel hostname, e.g. blitz.fengco.tech
 *  ARGO_AUTH    - Cloudflare tunnel token for that hostname
 *  NEZHA_SERVER - Nezha panel, e.g. nezha2026.5785787.xyz:443
 *  NEZHA_KEY    - Nezha client secret
 *  SUB_TOKEN    - optional token required as ?token= to read /sub
 *
 * The node link is deterministic from the env above, so the deployer can
 * build it without scraping the app: 
 * vless://UUID@ARGO_DOMAIN:443?encryption=none&security=tls&sni=ARGO_DOMAIN&type=ws&host=ARGO_DOMAIN&path=WS_PATH#NAME
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const SBX_PORT = parseInt(process.env.SBX_PORT || '18000', 10);
const WS_PATH = process.env.WS_PATH || '/blitz-ws';
const NAME = process.env.NAME || 'blitz';
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const NEZHA_SERVER = process.env.NEZHA_SERVER || '';
const NEZHA_KEY = process.env.NEZHA_KEY || '';
const SUB_TOKEN = process.env.SUB_TOKEN || '';

const BIN = path.join(__dirname, 'bin');
const SBX_VER = '1.12.12';
const CFD_VER = '2026.10.3';

function log(...a) { console.log(new Date().toISOString(), ...a); }

function uuid() {
  if (process.env.UUID) return process.env.UUID;
  const f = path.join(__dirname, '.uuid');
  try { if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const v = crypto.randomUUID();
  try { fs.writeFileSync(f, v); } catch {}
  log('UUID not set in env, generated and saved locally (will change if the app filesystem is wiped)');
  return v;
}
const UUID = uuid();

function sh(cmd) {
  log('$', cmd);
  execSync(cmd, { stdio: 'inherit', timeout: 180000 });
}

function download(url, dest) {
  if (fs.existsSync(dest)) return;
  const tmp = dest + '.tmp';
  sh(`curl -fsSL --retry 3 -o ${tmp} ${url}`);
  fs.renameSync(tmp, dest);
}

function ensureBinaries() {
  fs.mkdirSync(BIN, { recursive: true });
  // sing-box
  const sbx = path.join(BIN, 'sing-box');
  if (!fs.existsSync(sbx)) {
    const tgz = path.join(BIN, 'sing-box.tgz');
    download(`https://github.com/SagerNet/sing-box/releases/download/v${SBX_VER}/sing-box-${SBX_VER}-linux-amd64.tar.gz`, tgz);
    sh(`tar -xzf ${tgz} -C ${BIN} --strip-components=1 sing-box-${SBX_VER}-linux-amd64/sing-box && rm -f ${tgz}`);
  }
  fs.chmodSync(sbx, 0o755);
  // cloudflared
  const cfd = path.join(BIN, 'cloudflared');
  if (!fs.existsSync(cfd)) {
    download(`https://github.com/cloudflare/cloudflared/releases/download/${CFD_VER}/cloudflared-linux-amd64`, cfd);
  }
  fs.chmodSync(cfd, 0o755);
  return { sbx, cfd };
}

function writeSbxConfig() {
  const cfg = {
    log: { level: 'info' },
    inbounds: [{
      type: 'vless', tag: 'vless-ws',
      listen: '127.0.0.1', listen_port: SBX_PORT,
      users: [{ uuid: UUID, flow: '' }],
      transport: { type: 'ws', path: WS_PATH },
    }],
    outbounds: [{ type: 'direct', tag: 'direct' }],
  };
  const p = path.join(BIN, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

function run(name, cmd, args, restartMs = 5000) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[${name}] ${d}`));
  child.on('exit', (code) => {
    log(`${name} exited (${code}), restarting in ${restartMs}ms`);
    setTimeout(() => run(name, cmd, args, restartMs), restartMs);
  });
  child.on('error', (e) => {
    log(`${name} spawn error:`, e.message);
    setTimeout(() => run(name, cmd, args, restartMs), restartMs);
  });
  return child;
}

function nodeLink() {
  if (!ARGO_DOMAIN) return '';
  const q = `encryption=none&security=tls&sni=${ARGO_DOMAIN}&type=ws&host=${ARGO_DOMAIN}&path=${encodeURIComponent(WS_PATH)}`;
  return `vless://${UUID}@${ARGO_DOMAIN}:443?${q}#${encodeURIComponent(NAME)}`;
}

async function main() {
  // Health / info server first, so Blitz sees the app up even while binaries download.
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/sub') {
      if (SUB_TOKEN && u.searchParams.get('token') !== SUB_TOKEN) {
        res.writeHead(403); res.end('forbidden'); return;
      }
      const link = nodeLink();
      if (!link) { res.writeHead(503); res.end('tunnel not configured'); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(link + '\n'); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`blitz-sbx ok name=${NAME} ws=${WS_PATH} tunnel=${ARGO_DOMAIN || '(not set)'}\n`);
  });
  server.listen(PORT, () => log(`http listening on ${PORT}`));

  try {
    const { sbx, cfd } = ensureBinaries();
    const cfg = writeSbxConfig();
    run('sing-box', sbx, ['run', '-c', cfg]);
    if (ARGO_AUTH && ARGO_DOMAIN) {
      run('cloudflared', cfd, ['tunnel', '--no-autoupdate', 'run', '--token', ARGO_AUTH]);
      log(`fixed tunnel: ${ARGO_DOMAIN} -> 127.0.0.1:${SBX_PORT} ${WS_PATH}`);
    } else {
      log('ARGO_AUTH/ARGO_DOMAIN not set, cloudflared not started');
    }
    if (NEZHA_SERVER && NEZHA_KEY) {
      // Nezha agent is best-effort: failure must not kill the node.
      try {
        const nz = path.join(BIN, 'nezha-agent');
        if (!fs.existsSync(nz)) {
          download('https://github.com/nezhahq/agent/releases/download/v1.14.0/nezha-agent_linux_amd64.zip', path.join(BIN, 'nezha.zip'));
          sh(`cd ${BIN} && (unzip -o nezha.zip nezha-agent || true) && rm -f nezha.zip`);
        }
        if (fs.existsSync(nz)) {
          fs.chmodSync(nz, 0o755);
          run('nezha', nz, ['-s', NEZHA_SERVER, '-p', NEZHA_KEY, '--tls']);
        }
      } catch (e) { log('nezha setup failed (non-fatal):', e.message); }
    }
    const link = nodeLink();
    if (link) log('node link ready (do not paste secrets in logs in production)');
  } catch (e) {
    log('startup failed:', e.message);
    // Keep the HTTP server up so Blitz reports the app as running and logs are visible.
  }
}

main();
