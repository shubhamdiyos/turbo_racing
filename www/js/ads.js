// AdManager — wired to @capacitor-community/admob for Android & iOS
// Test Ad Unit IDs are pre-configured; swap with real IDs before release.

let admobPlugin = null;

async function loadAdMobPlugin() {
  try {
    // Only attempt native plugin when running inside Capacitor (Android/iOS)
    // In a plain browser there is no module resolver for bare specifiers like
    // '@capacitor-community/admob', so we guard with window.Capacitor check.
    if (!window.Capacitor || window.Capacitor.getPlatform() === 'web') {
      console.log('[AdManager] Running in browser — AdMob native plugin skipped');
      return;
    }
    // These web assets are plain ES modules with no bundler pass, so the bare specifier above
    // cannot resolve inside the WebView even though the plugin is compiled into the app.
    // Capacitor proxies every registered native plugin onto window.Capacitor.Plugins.
    if (window.Capacitor.Plugins && window.Capacitor.Plugins.AdMob) {
      admobPlugin = window.Capacitor.Plugins.AdMob;
    } else {
      admobPlugin = (await import('@capacitor-community/admob')).AdMob;
    }
    await admobPlugin.initialize({
      requestTrackingAuthorization: true, // iOS ATT prompt
      testingDevices: [],
      initializeForTesting: false,
    });
    console.log('[AdManager] AdMob initialized');
  } catch (e) {
    admobPlugin = null;
    console.warn('[AdManager] AdMob native plugin not available (browser fallback):', e.message);
  }
}

export const AdManager = {
  lastInterstitialTime: 0,
  interstitialCooldownMs: 180000,
  completedRuns: 0,

  // Ad Unit IDs — Test IDs pre-loaded; replace with real IDs for release
  AD_UNITS: {
    android: {
      rewarded: 'ca-app-pub-3940256099942544/5224354917',
      interstitial: 'ca-app-pub-3940256099942544/1033173712',
    },
    ios: {
      rewarded: 'ca-app-pub-3940256099942544/1712485313',
      interstitial: 'ca-app-pub-3940256099942544/4411468910',
    },
  },

  _getPlatform() {
    // Capacitor sets window.Capacitor.getPlatform() at runtime
    if (window.Capacitor && window.Capacitor.getPlatform) {
      return window.Capacitor.getPlatform(); // 'android' | 'ios' | 'web'
    }
    return 'web';
  },

  async init() {
    await loadAdMobPlugin();
    console.log('[AdManager] Ready for Android & iOS AdMob Mediation');
  },

  async showRewardedAd(placementTitle, onReward) {
    const platform = this._getPlatform();
    const adUnitId = this.AD_UNITS[platform]?.rewarded;

    if (admobPlugin && adUnitId) {
      try {
        await admobPlugin.prepareRewardVideoAd({ adId: adUnitId });
        const result = await admobPlugin.showRewardVideoAd();
        if (result && result.type === 'Rewarded') {
          onReward();
        }
        return;
      } catch (e) {
        console.warn('[AdManager] Rewarded ad error:', e.message);
      }
    }

    // Browser / fallback: use confirm dialog
    if (confirm(`📺 [${placementTitle}]\nWatch a short video to activate your reward?`)) {
      onReward();
    }
  },

  async tryShowInterstitial() {
    this.completedRuns++;
    const now = Date.now();
    if (this.completedRuns <= 2 || (now - this.lastInterstitialTime) < this.interstitialCooldownMs) {
      return;
    }

    const platform = this._getPlatform();
    const adUnitId = this.AD_UNITS[platform]?.interstitial;

    if (admobPlugin && adUnitId) {
      try {
        await admobPlugin.prepareInterstitial({ adId: adUnitId });
        await admobPlugin.showInterstitial();
        this.lastInterstitialTime = now;
        console.log('[AdManager] Interstitial shown');
      } catch (e) {
        console.warn('[AdManager] Interstitial error:', e.message);
      }
    } else {
      this.lastInterstitialTime = now;
      console.log('[AdManager] Interstitial (browser) – skipped');
    }
  },
};
