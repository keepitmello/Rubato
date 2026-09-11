# Remote Windows Krea2

Operate keepi's Windows Krea2 installation from the Mac without duplicating its ComfyUI graph.

## Direct generation

Use `invoke-krea2.sh` for ordinary T2I and identity-preserving I2I requests. For I2I, pass the identity source as `--input-image FILE`. Windows first generates the requested adult scene with Moody V7, then Krea2 Identity Edit v1.2 transfers the source face into that scene. The wrapper uses unique temporary paths, removes uploads, copies the result back to Mac, and verifies its SHA-256.

All calls reuse the single owned ComfyUI server on Windows port 8188. The Windows canonical scripts serialize server startup with a shared lock and never open ComfyUI browser tabs. Do not start another ComfyUI instance from Mac or Claude.

Windows automatically unloads cached models after 30 idle minutes and stops the owned ComfyUI server after 120 idle minutes. Running/pending work resets the timer, and the next Krea call starts the singleton server and hidden watchdog again. For immediate cleanup over SSH, use the Windows canonical manager with `-Action Free` or `-Action Stop`; both refuse while the queue is busy. `-Action Status` reports the active policy and last watchdog decision.

When a satisfactory NSFW target already exists, add `--target-scene FILE`. This skips Moody generation and performs only the two-image identity transfer: target scene is image 1 and identity source is image 2.

MoodyV7 is the Windows script default. Pass `--profile Stock --width 1024 --height 1024` only when the user explicitly requests the official stock model or broad non-photorealistic Krea 2 styling.

I2I defaults to `--identity-priority Strict --edit-speed Quality`, which uses identity strength 4, grounding 768 px, and 10 identity steps. `Normal` lowers identity strength to 3. `Fast` uses 8 identity steps, but the validated AMD run was slower and changed more of the target pose, so do not choose it automatically. Width, height, and steps control the Moody scene stage when `--target-scene` is omitted.

Adult/NSFW I2I is in scope. Make every subject explicitly age 25 or older. Moody owns the adult scene; the SFW-trained identity model is used only afterward to transfer the face. Verify the second stage retained exposure rather than blurring, blocking, or silently re-clothing it. Compare the face and inspect anatomy, skin seams, clothing remnants, hands, subject count, and censorship drift.

After transfer, inspect source and result together. Report what identity, composition, pose, and details were preserved and changed. For adult/NSFW work, also check requested adult subject count, hands, anatomy, framing, skin artifacts, and censorship drift. Do not infer visual quality from JSON success alone.

## Route complex changes to Codex

Use Codex on the Windows/WSL worker instead of extending this shell wrapper for checkpoint/LoRA/VAE/encoder/custom-node installation, graph or canonical script changes, AMD/OOM/noise diagnosis, retained-browser research, comparative validation, or promotion of a new production default.

Dispatch with a unique `wy-server job` and a bounded brief. Confirm `codex login status`, observe `RUNNING`, then require terminal `SUCCEEDED` with `child_exit_code=0` and inspect its output log. Never clear or replace the retained Chrome profile. Require an original source, exact file/hash, RX 9070 XT compatibility, and a fixed-seed visual comparison before promoting a candidate model.
