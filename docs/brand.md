# styal brand

styal is an open-source control plane for coding agents, forked from
[T3 Code](https://github.com/pingdotgg/t3code). The name comes from the Cheshire village around
Quarry Bank Mill.

The mill history is backstory only. Nothing in the identity should literally depict threads, looms,
spindles, or mills. No fibre texture, no rope or yarn rendering.

The name is always lowercase, and always just `styal` — never "styal code", never a tagline.

The domain is `styal.build`. The web app is served from `app.styal.build`, which is the reverse of
the `build.styal.app` bundle id. `styal.dev` is held and redirects to `styal.build`.

## Wordmark

Zilla Slab Bold (Google Fonts, OFL), outlined to paths. Always lowercase.

Bold (700) is the heaviest weight the family ships; the slab serifs carry the weight a Black would.

Spacing is set per pair, never by a global tracking value. Each pair is matched on perceived white,
measured as gap area across the x-height band, subject to a hard 1.0px minimum ink clearance at a
40px wordmark so no pair can be optimised into a collision.

`ty` is the binding pair — the `t` crossbar reaches into the `y` arm — so negative tracking closes it
long before it improves anything else. Do not apply one.

## Logomark

A lowercase `s` from the same face, upright. No rotation, slant or twist.

A single heavy letter is a crowded space generally. Prefer the wordmark wherever it fits; use the
`s` alone only where a five-letter wordmark physically cannot work — the favicon and the app icon.
No trademark clearance has been done.

## Palette

Monochrome first — near-black and off-white in both light and dark modes.

The app icons keep the teal grounds inherited from upstream, as sRGB: production `#00242C`, nightly
`#001A20`, development `#00313D`. Those three are nearly indistinguishable as flat colour; what
actually separates the variants is their extra Icon Composer layers — the development blueprint grid
and the nightly clouds and stars.

## Assets

Source outlines live in `assets/brand/`:

- `wordmark.svg` and `mark.svg` use `currentColor`, so one file serves light and dark.
- `wordmark-light.svg` and `wordmark-dark.svg` bake their fills, for contexts that cannot set
  `currentColor` such as a README or the GitHub avatar.

The three Icon Composer projects under `assets/{dev,nightly,prod}/app-icon.icon/` share a single
`text.svg` glyph layer: the `s` on a flat 128x128 canvas, no mask, no shadow, no gradient. Icon
Composer supplies the squircle and the liquid glass. See `assets/README.md` for the export workflow,
including the macOS `pre-Tahoe` step that can only be done in the GUI.

`favicon.svg` is authored by hand per brand rather than rendered, because Icon Composer only emits
raster. It is tracked as a source asset and copied by the export script.

## Constraints

- Final SVGs are outlined paths. No runtime font dependency.
- Flat shapes only in the mark; let the system glass do the work.
- No taglines. No "code" appended.

## Open

- **Typeface.** Zilla Slab is a working choice, not a final one.

## Release codenames

Deferred, not in use yet: `jenny`, `bobbin`, `whirr`, `throstle` — mill machinery.
