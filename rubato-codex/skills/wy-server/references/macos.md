# macOS host

For substantive Windows diagnosis or changes, create a Windows Codex peer task:

```bash
python3 ~/.codex/skills/codex-peer/scripts/codex_peer.py --host windows create --cwd 'C:/Users/keepi' --message '<task>'
```

Run the public `wy-server` CLI directly for Windows worker lifecycle and WSL execution. Use direct SSH only for bounded probes, bootstrap recovery, deterministic commands, and files.

```bash
wy-server health
wy-server ensure
wy-server run '<command>'
ssh -o BatchMode=yes -o ConnectTimeout=8 wy-desktop whoami
```

On Windows SFTP, begin at `/C:/Users/keepi`; address other drives as `/D:/`. Access remains bounded by the authenticated Windows account.

For detached work, use a unique job ID, quote the WSL working directory so the Mac shell does not expand `~`, and begin multi-step commands with `set -e`. Inspect `~/.local/state/mac-worker/jobs/<id>/output.log` when the output matters.

For ordinary Krea2 T2I/I2I, use `krea/invoke-krea2.sh`. Route model installation, graph changes, AMD/OOM diagnosis, or skill-contract changes to the Windows implementation path and require verified output before promotion.

The Mac Wi-Fi and desktop Ethernet are on different LAN subnets. `wy-server wake` uses unicast packets to `192.168.55.194` on ports 9 and 7 with directed broadcast only as fallback. After wake, require a fresh `wy-server health` result.
