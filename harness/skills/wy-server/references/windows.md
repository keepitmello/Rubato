# Windows host

Use Windows-native PowerShell for Windows apps, services, registry, GPU, ComfyUI, and power configuration. Use WSL for Linux repositories and containers.

For substantive Mac diagnosis or changes, create a Mac Codex peer task:

```powershell
python "$env:USERPROFILE\.codex\skills\codex-peer\scripts\codex_peer.py" --host mac --remote-path "/Users/wy/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" create --cwd "/Users/wy" --message "<task>"
```

Use direct SSH only for bounded probes, bootstrap recovery, deterministic file transfer, or the `wy-server` controller:

```powershell
ssh -o BatchMode=yes -o ConnectTimeout=8 mac "wy-server health"
ssh mac "wy-server ensure"
ssh mac "wy-server run '<command>'"
```

For direct Mac files, use `sftp mac` or `scp`. Begin at `/Users/wy`.

For local Windows Krea2/ComfyUI work, use the canonical Windows implementation documented by `krea/KREA2.md`; do not bounce an already-local operation through Mac unless the controller lifecycle is required.

Before relying on administrative authority, inspect the effective token with `whoami /all`. Do not infer SYSTEM access. Keep an authorized remote administrator operation within the user's requested scope.

For power work, distinguish display-off from actual sleep and verify with Windows power events or `powercfg` evidence. The known WOL target is `WORKER_LAN_IP=192.168.55.194`; do not change it from a stale probe.
