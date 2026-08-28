import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * Hosts the styal web app on Cloudflare, alongside the relay stack rather than
 * on a second vendor.
 *
 * This is a rolling deployment of `main`, not a release artifact: styal has no
 * stable desktop release yet, so gating the hosted app on one (upstream's
 * model) would mean never deploying it. Desktop builds stay versioned and
 * promoted; the web app simply tracks the patch stack.
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
    const domain = yield* Config.nonEmptyString("STYAL_WEB_DOMAIN");

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
