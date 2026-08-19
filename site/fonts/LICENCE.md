# Fonts

Three faces, all SIL Open Font Licence 1.1, all served from this domain because
the page's CSP forbids a third-party request and the colophon promises there
isn't one. Each is a Latin subset of the upstream variable font.

| File | Family | Upstream |
|---|---|---|
| `fraunces-latin.woff2` | Fraunces Regular, `opsz` 9–144, `wght` 100–900 | Copyright 2020 The Fraunces Project Authors (github.com/undercasetype/Fraunces) |
| `fraunces-italic-latin.woff2` | Fraunces Italic, same axes | as above |
| `inter-latin.woff2` | Inter | Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) |
| `jetbrains-mono-latin.woff2` | JetBrains Mono | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) |

Licensed under the SIL Open Font License, Version 1.1, available with a FAQ at
<https://openfontlicense.org>. The fonts are distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

## One correction against the upstream copies

The two Fraunces subsets are shared across the ForgeSworn sites, and upstream
their contents are swapped: the file named `fraunces-latin.woff2` holds the
italic cut and `fraunces-italic-latin.woff2` holds the roman. The name tables
are unambiguous — subfamily `Italic`, `macStyle` bit 1 set, `italicAngle` −16 —
so every site declaring the first as `font-style: normal` has been setting its
upright headings in Fraunces Italic, and its `<em>` in the roman.

The copies here are swapped back so that each file holds what its name says.
The filenames are otherwise unchanged, so the fix is a straight byte swap for
any other site that wants it.
