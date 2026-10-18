// Shared by the picker and request pool (packaged into both directories).
// An external setup-token is the primary account; every stored login is then
// a manual sub lane, including a first browser login stored as a flat credential.
export function accountLaneSlotNames(slots) {
  const names = (Array.isArray(slots) ? slots : []).map((slot) => slot?.name).filter((name) => typeof name === "string");
  const named = ["sub", "sub2"].filter((name) => names.includes(name));
  const logins = names.filter((name) => /^login-\d+$/.test(name))
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  const ordered = [...named, ...logins];
  if (names.includes("setup-token")) {
    ordered.push(...names.filter((name) => name !== "setup-token" && !ordered.includes(name)));
  }
  return ordered;
}

export function credentialAccountLanes(credential, hasSetupToken = false) {
  const stored = Array.isArray(credential?.accounts) && credential.accounts.length > 0
    ? credential.accounts
    : credential?.type ? [{ name: "default" }] : [];
  return accountLaneSlotNames([...stored, ...(hasSetupToken ? [{ name: "setup-token" }] : [])]);
}
