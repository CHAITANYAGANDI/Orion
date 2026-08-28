# Fonts bundled with the PDF export

A PDF carries its own typesetting. Unlike a DOCX — which names a font and lets
Word find one — a PDF that references a font the reader does not have draws
empty boxes, so the glyphs for every script Orion works in have to be here.

| File | Covers |
|---|---|
| `NotoSans-Regular/Bold.ttf` | Latin, Latin Extended (Vietnamese, Turkish), Greek, Cyrillic — thirteen of the eighteen languages |
| `NotoSansArabic-Regular/Bold.ttf` | Arabic |
| `NotoSansHebrew-Regular/Bold.ttf` | Hebrew |
| `NotoSansDevanagari-Regular/Bold.ttf` | Hindi |

Japanese and Chinese are **not** here. They reference the Adobe character
collections that ship inside OpenPDF (`HeiseiKakuGo-W5` / Adobe-Japan1 and
`STSong-Light` / Adobe-GB1), which embed no glyphs and let the reader supply
them — the standard arrangement for CJK, and the reason this directory is under
two megabytes rather than eighteen.

Fonts are embedded **subset**, so a generated PDF carries only the characters it
actually used.

Source: <https://github.com/notofonts>, the `hinted/ttf` builds.
Licence: SIL Open Font License 1.1, in `LICENSE-OFL.txt`.

See `com.orion.export.PdfFonts` for how they are selected, and for the one
known limit — OpenPDF does not shape Devanagari, so Hindi is legible but not
correctly typeset.
