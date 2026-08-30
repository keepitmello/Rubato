# Rubato runtime package

This directory contains the local Pi package built and installed by Rubato.

Use the repository installer instead of installing this package directly:

```bash
./install.sh --apply
```

The package provides Rubato's Senpi extension, bundled skills, task runtime, memory tools,
LSP tools, and structural search tools. Generated extension files are built from the source
under `packages/` and staged outside the repository by `harness/scripts/build-engine.mjs`.

See [the public user guide](../../../harness/README.md) for installation, updates, and
troubleshooting.
