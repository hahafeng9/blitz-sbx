/**
 * blitz-sbx - a clean, small VLESS+WS node for Blitz (and any Node PaaS).
 *
 * Blitz port rule (blitz.cloud/docs, 2026-09-26 / 2026-10-19):
 *  - An app serves HTTP on ONE TCP port. Blitz tells the app to listen on
 *    8080 through the PORT env var; a Dockerfile EXPOSE other than 8080 is
 *    read from the image and used instead. A background app gets no address
 *    and no port at all from Blitz.
 *  - v3 broke this rule in practice: Node owned $PORT (8080) for health
 *    checks while xray listened on a second, undeclared port 18000, and
 *    cloudflared dialled 127.0.0.1:18000. The app stayed Online and the
 *    tunnel stayed connected, but every public request to the tunnel
 *    returned an empty reply - the second port was never reachable.
 *    Local xray on the same config answers plain GET with 400 and a WS
 *    upgrade with 101, so the tunnel path, not xray, was the break.
 *  - v4 fix: xray itself owns the one supported port, $PORT (default
 *    8080, EXPOSE 8080 in the Dockerfile). There is no second HTTP server
 *    and no second port. cloudflared dials 127.0.0.1:$PORT, the tunnel
 *    ingress must point at the same $PORT. The /sub endpoint is dropped
 *    with the health server; the node link is deterministic from env
 *    (see below), so nothing needs to scrape the app for it.
 *
 * How it works (v4):
 *  - At startup it downloads xray-core and cloudflared (linux amd64) into ./bin,
 *    writes an xray config from env vars, and runs both.
 *    (v1 used sing-box, but sing-box died at "start service" in the Blitz
 *    sandbox with no config detail, so the core was switched to xray.)
 *  - xray listens only on 127.0.0.1:$PORT with VLESS+WS at WS_PATH.
 *  - cloudflared connects outbound with ARGO_AUTH and serves ARGO_DOMAIN,
 *    so the fixed tunnel hostname is the only public entry point.
 *  - Nezha agent is optional: set NEZHA_SERVER and NEZHA_KEY to enable it.
 *    (v1.14.0 has no -s/-p flags; it is started with NZ_* env vars.)
 *
 * Env vars (set in the Blitz dashboard, never in this repo):
 *  UUID         - VLESS user id (required for a stable node link)
 *  NAME         - node display name, default "blitz"
 *  WS_PATH      - WebSocket path, default "/blitz-ws"
 *  ARGO_DOMAIN  - fixed tunnel hostname, e.g. blitz.fengco.tech
 *  ARGO_AUTH    - Cloudflare tunnel token for that hostname
 *  NEZHA_SERVER - Nezha panel, e.g. nezha2026.5785787.xyz:443
 *  NEZHA_KEY    - Nezha client secret
 *  PORT         - the one supported port, set by Blitz (default 8080).
 *                 SBX_PORT is intentionally ignored in v4; do not set it.
 *
 * The node link is deterministic from the env above, so the deployer can
 * build it without scraping the app:
 * vless://UUID@ARGO_DOMAIN:443?encryption=none&security=tls&sni=ARGO_DOMAIN&type=ws&host=ARGO_DOMAIN&path=WS_PATH#NAME
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

// The ONE supported port. Blitz sets PORT=8080; background apps may not
// set it at all, hence the same 8080 default. Do not add a second port.
const PORT = parseInt(process.env.PORT || '8080', 10);
const SBX_PORT = PORT;
const WS_PATH = process.env.WS_PATH || '/blitz-ws';
const NAME = process.env.NAME || 'blitz';
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const NEZHA_SERVER = process.env.NEZHA_SERVER || '';
const NEZHA_KEY = process.env.NEZHA_KEY || '';

const BIN = path.join(__dirname, 'bin');
const XRAY_VER = '26.10.21';
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
  // xray-core (zip, needs unzip from the Dockerfile)
  const core = path.join(BIN, 'xray');
  if (!fs.existsSync(core)) {
    const zip = path.join(BIN, 'xray.zip');
    download(`https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VER}/Xray-linux-64.zip`, zip);
    sh(`cd ${BIN} && unzip -o xray.zip xray && rm -f xray.zip`);
  }
  fs.chmodSync(core, 0o755);
  // cloudflared
  const cfd = path.join(BIN, 'cloudflared');
  if (!fs.existsSync(cfd)) {
    download(`https://github.com/cloudflare/cloudflared/releases/download/${CFD_VER}/cloudflared-linux-amd64`, cfd);
  }
  fs.chmodSync(cfd, 0o755);
  return { core, cfd };
}

function writeCoreConfig() {
  const cfg = {
    log: { loglevel: 'info' },
    inbounds: [{
      port: SBX_PORT, listen: '127.0.0.1', protocol: 'vless',
      settings: { clients: [{ id: UUID }], decryption: 'none' },
      streamSettings: { network: 'ws', wsSettings: { path: WS_PATH } },
    }],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }],
  };
  const p = path.join(BIN, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

function run(name, cmd, args, restartMs = 5000, extraEnv = null) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: extraEnv ? { ...process.env, ...extraEnv } : process.env });
  child.stdout.on('data', d => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[${name}] ${d}`));
  child.on('exit', (code) => {
    log(`${name} exited (${code}), restarting in ${restartMs}ms`);
    setTimeout(() => run(name, cmd, args, restartMs, extraEnv), restartMs);
  });
  child.on('error', (e) => {
    log(`${name} spawn error:`, e.message);
    setTimeout(() => run(name, cmd, args, restartMs, extraEnv), restartMs);
  });
  return child;
}

function nodeLink() {
  if (!ARGO_DOMAIN) return '';
  const q = `encryption=none&security=tls&sni=${ARGO_DOMAIN}&type=ws&host=${ARGO_DOMAIN}&path=${encodeURIComponent(WS_PATH)}`;
  return `vless://${UUID}@${ARGO_DOMAIN}:443?${q}#${encodeURIComponent(NAME)}`;
}

async function main() {
  // v4: no separate HTTP server. Blitz supports ONE port per app ($PORT),
  // and xray owns it. A second server on $PORT would conflict with xray,
  // and a server on any other port is not the supported port. The node
  // link is deterministic from env, so no /sub endpoint is needed.
  log(`single-port mode: xray will own 127.0.0.1:${PORT} ${WS_PATH} (tunnel=${ARGO_DOMAIN || '(not set)'})`);

  try {
    const { core, cfd } = ensureBinaries();
    const cfg = writeCoreConfig();
    run('xray', core, ['run', '-c', cfg]);
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
          // v1.14.0 agent has no -s/-p flags (it is config/env based);
          // the old flags made it exit every 5s. Use NZ_* env vars instead.
          // UUID is a valid UUID (the VLESS id), which v1 requires.
          const tls = /:(443|8443|2096|2087|2083|2053)$/.test(NEZHA_SERVER) ? 'true' : 'false';
          run('nezha', nz, [], 5000, {
            NZ_SERVER: NEZHA_SERVER, NZ_CLIENT_SECRET: NEZHA_KEY, NZ_TLS: tls,
            NZ_UUID: UUID, NZ_REPORT_DELAY: '4', NZ_DISABLE_AUTO_UPDATE: 'true',
            NZ_SKIP_CONNECTION_COUNT: 'true', NZ_SKIP_PROCS_COUNT: 'true',
          });
        }
      } catch (e) { log('nezha setup failed (non-fatal):', e.message); }
    }
    const link = nodeLink();
    if (link) log('node link ready (do not paste secrets in logs in production)');
  } catch (e) {
    log('startup failed:', e.message);
    // No HTTP server to keep up in v4; the launcher process itself stays
    // alive so Blitz reports the app as running and logs stay visible.
    // Keep the process alive rather than exiting into a crash loop.
    setInterval(() => {}, 60000);
  }
}

main();
