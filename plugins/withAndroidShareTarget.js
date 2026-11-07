// ============================================================
// plugins/withAndroidShareTarget.js
//
// Custom Expo Config Plugin that adds TWO native capabilities to
// Tify on Android:
//   1. Android Share Sheet Target (`android.intent.action.SEND` for
//      `text/plain`) so Tify appears in the Share menu inside Spotify!
//   2. Forwards the shared text (`Intent.EXTRA_TEXT`) into a deep link
//      (`tify://share?text=...`) inside MainActivity so React Native's
//      `Linking` module receives the Spotify URL automatically!
// ============================================================

const { withAndroidManifest, withMainActivity } = require('@expo/config-plugins');

function withShareSheetManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const mainApplication = cfg.modResults.manifest.application?.[0];
    if (!mainApplication) return cfg;

    const mainActivity = mainApplication.activity?.find(
      (a) => a.$?.['android:name'] === '.MainActivity'
    );
    if (!mainActivity) return cfg;

    mainActivity['intent-filter'] = mainActivity['intent-filter'] || [];

    // Avoid duplicating if already added
    const alreadyHasSend = mainActivity['intent-filter'].some((f) =>
      f.action?.some((a) => a.$?.['android:name'] === 'android.intent.action.SEND')
    );

    if (!alreadyHasSend) {
      mainActivity['intent-filter'].push({
        action: [{ $: { 'android:name': 'android.intent.action.SEND' } }],
        category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
        data: [{ $: { 'android:mimeType': 'text/plain' } }],
      });
    }

    return cfg;
  });
}

function withShareSheetMainActivity(config) {
  return withMainActivity(config, (cfg) => {
    let contents = cfg.modResults.contents;

    if (contents.includes('handleSpotifyShareIntent')) {
      return cfg;
    }

    // Add Android Intent & Uri imports (NOTE: Kotlin does NOT use semicolons
    // after `package com.fashmayor.tify`, so `;?` must be optional!)
    if (!contents.includes('import android.content.Intent')) {
      contents = contents.replace(
        /package\s+[\w.]+;?\r?\n/,
        (match) => `${match}import android.content.Intent\nimport android.net.Uri\n`
      );
    }

    // We also use fully-qualified `android.content.Intent` and `android.net.Uri`
    // inside the injected methods so it compiles cleanly no matter what!
    const helperCode = `
  private fun handleSpotifyShareIntent(intent: android.content.Intent?) {
    if (intent?.action == android.content.Intent.ACTION_SEND && intent.type == "text/plain") {
      val sharedText = intent.getStringExtra(android.content.Intent.EXTRA_TEXT)
      if (!sharedText.isNullOrBlank()) {
        val encoded = android.net.Uri.encode(sharedText)
        intent.action = android.content.Intent.ACTION_VIEW
        intent.data = android.net.Uri.parse("tify://share?text=" + encoded)
      }
    }
  }

  override fun onNewIntent(intent: android.content.Intent) {
    handleSpotifyShareIntent(intent)
    super.onNewIntent(intent)
  }
`;

    // Call handleSpotifyShareIntent(intent) at the start of onCreate
    contents = contents.replace(
      /override fun onCreate\(savedInstanceState: Bundle\?\) \{/,
      `override fun onCreate(savedInstanceState: Bundle?) {\n    handleSpotifyShareIntent(intent)`
    );

    // Insert helper method before the final closing brace of MainActivity
    const lastBrace = contents.lastIndexOf('}');
    if (lastBrace !== -1) {
      contents =
        contents.slice(0, lastBrace) + helperCode + '\n' + contents.slice(lastBrace);
    }

    cfg.modResults.contents = contents;
    return cfg;
  });
}

module.exports = function withAndroidShareTarget(config) {
  config = withShareSheetManifest(config);
  config = withShareSheetMainActivity(config);
  return config;
};
