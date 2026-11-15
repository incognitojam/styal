import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
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
    const { stage } = yield* Alchemy.Stack;

    // Files that earlier builds served, for tabs still running them. The deploy job copies each
    // build's assets in (scripts/sync-old-assets.ts) and re-uploads any older than a week, so a
    // file stays here 23 to 30 days after the last build that contained it.
    const oldAssets = yield* Cloudflare.R2.Bucket("OldAssets", {
      name: stage === "prod" ? "styal-web-old-assets" : `styal-web-old-assets-${stage}`,
      lifecycleRules: [
        {
          id: "expire-old-assets",
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 30 * 86400 } },
          abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86400 } },
        },
      ],
    });

    const site = yield* Cloudflare.Website.StaticSite("Web", {
      cwd: "../..",
      command: "vp run --filter @t3tools/web build",
      outdir: "apps/web/dist",
      main: "./src/worker.ts",
      domain,
      assets: {
        notFoundHandling: "single-page-application",
      },
      env: { OLD_ASSETS: oldAssets },
    });

    return {
      domain,
      oldAssetsBucket: oldAssets.bucketName,
      url: site.url,
      workerName: site.workerName,
    };
  }),
);
