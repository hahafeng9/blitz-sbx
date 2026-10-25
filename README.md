# blitz-sbx

A clean, small VLESS+WS node for Blitz (and any Node PaaS).

It runs sing-box locally on 127.0.0.1, serves it through a fixed
Cloudflare tunnel, and exposes a plain HTTP health page on `$PORT`
(Blitz default 8080). No secrets are in this repo.

## Env vars (set in the Blitz dashboard)

| Var | Meaning |
|---|---|
| `UUID` | VLESS user id |
| `NAME` | Node display name, default `blitz` |
| `WS_PATH` | WebSocket path, default `/blitz-ws` |
| `SBX_PORT` | sing-box local port, default `18000` |
| `ARGO_DOMAIN` | Fixed tunnel hostname, e.g. `blitz.fengco.tech` |
| `ARGO_AUTH` | Cloudflare tunnel token for that hostname |
| `NEZHA_SERVER` | Optional Nezha panel, e.g. `nezha2026.5785787.xyz:443` |
| `NEZHA_KEY` | Optional Nezha client secret |
| `SUB_TOKEN` | Optional token required as `?token=` to read `/sub` |

## Node link

Built from the env above:

```
vless://UUID@ARGO_DOMAIN:443?encryption=none&security=tls&sni=ARGO_DOMAIN&type=ws&host=ARGO_DOMAIN&path=WS_PATH#NAME
```

## Blitz notes

- Deploy as a normal web app, or as a background app if you want it to
  never sleep. On the free plan a background app still stops after
  2 days without a sign-in, deploy, or dashboard visit.
- The app downloads sing-box and cloudflared (linux amd64) on first start.
