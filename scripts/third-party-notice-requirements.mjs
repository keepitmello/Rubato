export const BUNDLED_NOTICE_HEADINGS = [
  "pi-lsp-client",
  "ast-grep-skill",
  "Open Design",
  "taste-skill",
  "UI/UX Pro Max",
  "designpowers",
  "insane-search",
  "zmx",
]

export const PACKAGE_NOTICE_REQUIREMENTS = [
  {
    path: "packages/lsp-core",
    requiredFiles: ["NOTICE"],
    requiredTerms: ["pi-lsp-client", "oh-my-pi", "Yeongyu Kim"],
  },
  {
    path: "packages/lsp-daemon",
    requiredFiles: ["NOTICE"],
    requiredTerms: ["pi-lsp-client", "@rubato/lsp-core"],
  },
  {
    path: "packages/rubato-runtime/plugin",
    requiredFiles: ["LICENSE", "NOTICE"],
    requiredTerms: ["pi-lsp-client", "oh-my-pi", "Yeongyu Kim"],
  },
]
