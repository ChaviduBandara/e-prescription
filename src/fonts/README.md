# Fonts for the archive PDF

Used by `src/pdf-text.js` to print Sinhala and Tamil text in the session
PDF. Bundled here so nothing is downloaded at runtime.

| File | Font | Source |
|---|---|---|
| `NotoSansSinhala-Regular.ttf`, `NotoSansSinhala-Bold.ttf` | Noto Sans Sinhala | https://github.com/notofonts/sinhala (static hinted TTF) |
| `NotoSansTamil-Regular.ttf`, `NotoSansTamil-Bold.ttf` | Noto Sans Tamil | https://github.com/notofonts/tamil (static hinted TTF) |

Licence: SIL Open Font License 1.1, Copyright 2022 The Noto Project Authors.
The full text is in `NotoSansSinhala-OFL.txt` and `NotoSansTamil-OFL.txt`.
The fonts may be bundled and redistributed with this app; they must not be
sold on their own, and a modified version must not use the name "Noto".

To update a font, replace the file, then render a sample page (Sinhala,
Tamil and mixed English) and look at it before shipping, and run
`node --test tests/unit/pdf-text.test.js tests/unit/archive.test.js`.
