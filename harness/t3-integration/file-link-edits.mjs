// Chat links to files whose names are not ASCII (`output/제출용/01_답변서.pdf`).
//
// T3 decides that a relative link destination is a file by its shape, and the
// shape only allowed ASCII letters, digits, `.`, `_` and `-`. A Korean, Japanese
// or accented name failed it, so the link rendered as a plain web link: no file
// chip, and a click did not open the file in the right panel. The two patterns
// now take any Unicode letter, mark or digit. The rest stays: a relative link
// still needs a `/` or a file extension, so a bare word (`[설명](설명)`) is not a
// file, and the extension itself stays ASCII.
//
// rubatoMarkdownLinks.test.ts holds the cases.
export const fileLinkOverlays = ['packages/shared/src/rubatoMarkdownLinks.test.ts'];

// Upstream v0.1.11 accepts any script in file links itself; the test above keeps guarding it.
export const fileLinkEdits = {};
