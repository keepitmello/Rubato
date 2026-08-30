export function parseExtensionEntries(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token !== "-e" && token !== "--extension") continue;
    const value = argv[i + 1];
    if (value !== undefined && value.length > 0) {
      out.push(value);
      i += 1;
    }
  }
  return out;
}

export function buildChildExtensionArgs(extensions, dagOwned) {
  const args = ["--no-extensions"];
  const selected = dagOwned ? extensions.slice(1) : extensions;
  for (const path of selected) {
    if (path.length > 0) args.push("--extension", path);
  }
  return args;
}

export function hasExtension(argv, suffix) {
  return parseExtensionEntries(argv).some((path) => path.endsWith(suffix));
}
