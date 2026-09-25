# Brand icons

The three Icon Composer projects are the source of truth for full application icons:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`

Each project stacks the same reel layers — `reel-top.svg`, `reel-body.svg`, `reel-base.svg`, and `thread.svg`, the loose end, which must keep glass off (see `docs/brand.md`) — over the channel's fill, with `background.svg` when the channel has a vector background.

Run `vp run icons:export` from the repository root to regenerate the tracked iOS, Linux, Windows, and web assets. The development web exports are also copied to `apps/web/public` for the browser favicon and splash screen. Run `vp run icons:check` to verify that the generated assets and public copies match their sources without changing files.

Exporting requires Icon Composer 2 or newer on macOS. The script selects the newest compatible exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

## macOS exports

The desktop app's macOS icon is a classic `.icns`, which macOS draws exactly as its pixels are, so the PNG has to carry the classic safe area itself: a 1024×1024 canvas with an 824×824 opaque body inset 100 pixels on every side, and only a soft drop shadow in the margin.

Icon Composer cannot export that directly. Its command-line exporter has no pre-Tahoe rendering, and on macOS 27 the GUI's `macOS pre-Tahoe` preset exports full bleed. So the body is exported by hand and `vp run icons:export` adds the margin and shadow.

After changing an Icon Composer project, open it in Icon Composer, select the ⊘ rendering (no Liquid Glass) in the toolbar, and export the macOS PNG with these settings:

- Platform: `macOS pre-Tahoe`
- Appearance: `Default`
- Size: `Customize…` → `824pt`
- Scale: `1×`

Save the three exports over the tracked files:

- `dev/app-icon.icon` -> `dev/blueprint-macos-1024.png`
- `nightly/app-icon.icon` -> `nightly/nightly-macos-1024.png`
- `prod/app-icon.icon` -> `prod/black-macos-1024.png`

Then run `vp run icons:export`. Any macOS PNG that is still an 824×824 export is placed on the 1024×1024 canvas with the shadow, keeping the export's pixels and colour profile; finished icons are left alone. `vp run icons:check` reports an unfinished export as stale.

To have Codex perform the native exports, paste this prompt into a task opened at the repository root:

```text
Use [@Computer](plugin://computer-use@openai-bundled) and the Icon Composer app to export the three macOS app icons in this repository.

In Icon Composer's toolbar, select the ⊘ rendering (no Liquid Glass), then export each source with Platform: macOS pre-Tahoe, Appearance: Default, Size: Customize… 824pt, Scale: 1×, saving over the tracked PNG:

- assets/dev/app-icon.icon -> assets/dev/blueprint-macos-1024.png
- assets/nightly/app-icon.icon -> assets/nightly/nightly-macos-1024.png
- assets/prod/app-icon.icon -> assets/prod/black-macos-1024.png

Then run `vp run icons:export` again to add the macOS margin and shadow.

Verify every result is 1024×1024 and has the classic macOS safe area: an 824×824 opaque body inset 100px on every side, with only the drop shadow extending beyond it.
```

Do not edit the generated PNG or ICO files directly.

## Mobile marks

`apps/mobile/assets/android-icon-foreground.svg` is the source of truth for the foreground used by
the Android adaptive launcher icon and launcher shortcuts: the app icon's reel layers flattened
without glass. `apps/mobile/assets/android-icon-monochrome.svg` places the flat mark from
`assets/brand/mark.svg` at the same size and position for the themed icon. Export the PNGs after
changing either:

```sh
rsvg-convert -w 432 -h 432 \
  -o apps/mobile/assets/android-icon-foreground.png \
  apps/mobile/assets/android-icon-foreground.svg
rsvg-convert -w 432 -h 432 \
  -o apps/mobile/assets/android-icon-mark.png \
  apps/mobile/assets/android-icon-monochrome.svg
rsvg-convert -w 96 -h 96 \
  -o apps/mobile/assets/android-notification-icon.png \
  apps/mobile/assets/android-notification-icon.svg
```

Both foregrounds must remain transparent and keep every part of the reel, including the curl of
the loose end, inside Android's 66dp adaptive-icon safe circle. The notification SVG uses the same
white silhouette with padding on a transparent canvas.
Variant backgrounds in `apps/mobile/app.config.ts` follow the palette in `docs/brand.md`.

`apps/mobile/assets/widget/StyalMark.svg` is the same flat mark with a fixed black fill for
the iOS widget and Live Activity template image. `StyalWordmark.tsx` in the mobile components
directory carries the outlined `assets/brand/wordmark.svg` for both home headers.

Launcher, notification, and widget assets require a new native build; an OTA update alone cannot
replace them.
