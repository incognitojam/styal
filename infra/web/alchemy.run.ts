import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * A rolling deployment of `main`, not a release artifact: styal has no stable desktop
 * release to gate the hosted web app on.
 */
export default Alchemy.Stack(
  "StyalWeb",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // The zone must already exist in the Cloudflare account; Alchemy infers it
    // from this hostname rather than creating DNS for us.
    const domain = yield* Config.NonEmptyString("STYAL_WEB_DOMAIN");

    const site = yield* Cloudflare.Website.StaticSite("Web", {
      cwd: "../..",
      command: "vp run --filter @t3tools/web build",
      outdir: "apps/web/dist",
      main: "./src/worker.ts",
      domain,
      assets: {
        notFoundHandling: "single-page-application",
      },
    });

    return {
      domain,
      url: site.url,
      workerName: site.workerName,
    };
  }),
);
