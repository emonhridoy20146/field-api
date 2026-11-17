# Fonts for PDF exports

Used by `src/modules/reports/export/pdf.ts` (OD-26, ADR-030). The PDF writer shapes text with HarfBuzz and
embeds these files, so Bangla conjuncts render on any reader without fonts installed.

| File | Source | Licence |
|---|---|---|
| `NotoSansBengali-Regular.ttf`, `NotoSansBengali-Bold.ttf` | Noto Sans Bengali, hinted TTF from `notofonts/notofonts.github.io` (`fonts/NotoSansBengali/hinted/ttf/`) | SIL OFL 1.1, `OFL-NotoSansBengali.txt` |
| `NotoSansLatin-Regular.ttf`, `NotoSansLatin-Bold.ttf` | Noto Sans, hinted TTF from `notofonts/notofonts.github.io` (`fonts/NotoSans/hinted/ttf/`) | SIL OFL 1.1, `OFL-NotoSans.txt` |

The files are subsets, made with fonttools 4.60.1. All OpenType layout features are kept, because
Bangla shaping needs them:

```sh
pyftsubset NotoSansBengali-$W.ttf --unicodes="U+0020,U+00A0,U+0964-0965,U+0980-09FF,U+200C-200D,U+25CC" \
  --layout-features='*' --no-hinting --output-file=NotoSansBengali-$W.ttf
pyftsubset NotoSans-$W.ttf --unicodes="U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-203A,U+20AC,U+2116,U+2122,U+2212" \
  --layout-features='*' --no-hinting --output-file=NotoSansLatin-$W.ttf
```

Characters outside these ranges print as `?`. To support more scripts, add a subset here and a run
type in `pdf.ts`. Set `FONTS_DIR` to load the fonts from another folder; the default is
`./assets/fonts` under the working directory. The Dockerfile copies this folder into the image.
