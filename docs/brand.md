# styal brand

styal is an open-source control plane for coding agents, forked from
[T3 Code](https://github.com/pingdotgg/t3code). The name comes from the Cheshire village around
Quarry Bank Mill.

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

A cotton reel, tipped over, its loose end curling away across the ground — a nod to Quarry Bank
Mill. Prefer the wordmark wherever it fits; use the reel alone where a five-letter wordmark cannot
work. No trademark clearance has been done.

It comes in two forms:

- **The app icon reel** is drawn with volume: turned wooden flanges, a teal thread body with fine,
  irregular windings, and a loose end with a single curl and a frayed tip. It is not tapered, so it
  never reads as a snake.
- **The flat mark** is the same reel at the same angle as a one-colour silhouette, for sizes and
  surfaces that cannot carry shading: the favicon, Android's monochrome and notification icons,
  and the iOS widget. Each flange is split into face and rim so a single colour still reads as a
  disc.

The reel and its loose end are centred together, not the reel alone: the reel rides slightly high
and to the right, and the thread fills the lower-left corner.

## Palette

Monochrome first — near-black and off-white in both light and dark modes.

The reel is the same in every channel; the ground behind it tells the channels apart:

- **Production:** plain light, `#F2EEE6`.
- **Nightly:** `#0A2B34` under the starry night sky carried over from upstream's nightly icon.
- **Development:** `#1D5A55` with a cutting-mat grid, the sewing-table take on a blueprint.

Icon Composer turns each ground into an automatic gradient; Android's adaptive icons and the
favicons use the flat colour. The reel's thread is teal (`#4EDCE2`, shading down to `#135A63`) and
its flanges are warm wood (`#E7A96E`).

## Assets

Source outlines live in `assets/brand/`:

- `wordmark.svg` and `mark.svg` use `currentColor`, so one file serves light and dark.
- `wordmark-light.svg` and `wordmark-dark.svg` bake their fills, for contexts that cannot set
  `currentColor` such as a README.
- `avatar-1024.png` is the reel on the production ground, kept inside the circle GitHub crops to.

The three Icon Composer projects under `assets/{dev,nightly,prod}/app-icon.icon/` share the same
reel layers on a 128x128 canvas, plus a non-glass `background.svg` where the channel has one. Icon
Composer supplies the squircle, the glass, and the Dark, Clear and Tinted appearances. See
`assets/README.md` for the export workflow, including the macOS `pre-Tahoe` step that can only be
done in the GUI.

Keep the loose end (`thread.svg`) in its own layer with glass off. Icon Composer treats everything in
one glass layer as a single shape: with the thread in the reel's layer it draws a bright highlight
and a pale fill across the gap between them. The thread still sits in the reel's group, so it shares
the reel's shadow.

`favicon.svg` is authored by hand per brand rather than rendered, because Icon Composer only emits
raster. It is the flat mark in two tones, wood and thread, on the channel's ground. It is tracked as
a source asset and copied by the export script.

## Constraints

- Final SVGs are outlined paths. No runtime font dependency.
- The flat mark is flat shapes in one colour. The app icon layers carry their own shading; leave the
  glass, highlights and appearance variants to Icon Composer.
- No taglines. No "code" appended.

## Open

- **Typeface.** Zilla Slab is a working choice, not a final one.

## Release codenames

Deferred, not in use yet: `jenny`, `bobbin`, `whirr`, `throstle` — mill machinery.
