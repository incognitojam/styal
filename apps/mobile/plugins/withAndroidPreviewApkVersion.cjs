const { withAppBuildGradle } = require("expo/config-plugins");

// R8 reruns (about six minutes) whenever the version changes, so Gradle builds previews with a
// fixed version and aapt2 writes the real one into the APK manifest. Nothing reads BuildConfig's
// version fields; the app reads its version from the installed package.
const MARKER = "withAndroidPreviewApkVersion";

module.exports = function withAndroidPreviewApkVersion(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    const { contents, language } = nextConfig.modResults;
    if (language !== "groovy") {
      throw new Error(`${MARKER}: unsupported app build.gradle language "${language}".`);
    }
    if (contents.includes(MARKER)) return nextConfig;

    const versionCode = nextConfig.android?.versionCode ?? 1;
    const versionName = nextConfig.version ?? "1.0.0";
    nextConfig.modResults.contents = `${contents.trimEnd()}

// Added by ${MARKER}: keep the version out of R8's inputs.
android {
    defaultConfig {
        versionCode 1
        versionName "preview"
    }
    androidResources {
        additionalParameters.addAll([
            "--version-code", ${JSON.stringify(String(versionCode))},
            "--version-name", ${JSON.stringify(versionName)},
            "--replace-version",
        ])
    }
}
`;
    return nextConfig;
  });
};
