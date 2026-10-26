# blitz-sbx

A clean, small VLESS+WS node for Blitz (and any Node PaaS).

It runs xray-core on the one port Blitz supports, serves it through a fixed
Cloudflare tunnel, and optionally runs a Nezha agent. No secrets are in this repo.

## Blitz port rule

Blitz docs (blitz.cloud/docs): an app serves HTTP on ONE TCP port. Blitz
tells the app to listen on 8080 through the `PORT` env var, and a Dockerfile
`EXPOSE` other than 8080 is read from the image and used instead. A background
app gets no address and no port from Blitz.

That is why this app does NOT use a second port: xray itself listens on
`127.0.0.1:$PORT` (default 8080, `EXPOSE 8080` in the Dockerfile), and the
tunnel ingress must point at the same `$PORT`. Earlier versions ran a health
server on `$PORT` plus xray on 18000; the app stayed Online and the tunnel
stayed connected, but every public tunnel request returned an empty reply.

## Env vars (set in the Blitz dashboard)

| Var | Meaning |
|---|---|
| `UUID` | VLESS user id |
| `NAME` | Node display name, default `blitz` |
| `WS_PATH` | WebSocket path, default `/blitz-ws` |
| `ARGO_DOMAIN` | Fixed tunnel hostname, e.g. `blitz.fengco.tech` |
| `ARGO_AUTH` | Cloudflare tunnel token for that hostname |
| `NEZHA_SERVER` | Optional Nezha panel, e.g. `nezha2026.5785787.xyz:443` |
| `NEZHA_KEY` | Optional Nezha client secret |
| `PORT` | The one supported port, set by Blitz (default 8080). `SBX_PORT` is ignored since v4; do not set it. |

## Node link

Built from the env above:

```
vless://UUID@ARGO_DOMAIN:443?encryption=none&security=tls&sni=ARGO_DOMAIN&type=ws&host=ARGO_DOMAIN&path=WS_PATH#NAME
```

## Blitz notes

- Deploy as a normal web app, or as a background app if you want it to
  never sleep. On the free plan a background app still stops after
  2 days without a sign-in, deploy, or dashboard visit.
- The app downloads xray-core, cloudflared and (optionally) nezha-agent
  (linux amd64) on first start. Nezha agent v1.14.0 has no `-s`/`-p` flags
  and is started with `NZ_*` environment variables.
