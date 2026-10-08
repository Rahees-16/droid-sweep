'use strict';
// State machine describing the recorded fixture app. Keys in `taps` match resource-id, text or content-desc.
module.exports = {
  package: 'com.example.demo',
  density: 420,
  start: 'home',
  launcher: 'launcher.xml',
  screens: {
    home: { xml: 'home.xml', activity: 'com.example.demo.MainActivity', scrollXml: ['home_scrolled.xml'],
      taps: { btn_profile: 'profile', btn_settings: 'settings', btn_help: 'help', btn_web: 'external', btn_sync: 'sync',
        btn_reports: 'slow', btn_delete_all: 'deleted', et_name: 'typing', 'Item Z': 'more' } },
    profile: { xml: 'profile.xml', activity: 'com.example.demo.ProfileActivity', taps: { btn_logout: 'loggedout' } },
    settings: { xml: 'settings.xml', activity: 'com.example.demo.SettingsActivity', taps: {} },
    help: { xml: 'help.xml', activity: 'com.example.demo.HelpActivity', taps: {} },
    external: { xml: 'external.xml', activity: 'com.android.chrome.Main', pkg: 'com.android.chrome', taps: {} },
    sync: { xml: 'help.xml', activity: 'com.example.demo.SyncActivity', crash: 'logcat_crash.txt', taps: {} },
    slow: { xml: 'slow.xml', loadingXml: ['slow_loading_1.xml', 'slow_loading_2.xml', 'slow_loading_3.xml'], unstableDumps: 3, activity: 'com.example.demo.ReportsActivity', taps: {} },
    more: { xml: 'more.xml', activity: 'com.example.demo.MoreActivity', taps: {} },
    deleted: { xml: 'deleted.xml', activity: 'com.example.demo.DeletedActivity', taps: {} },
    typing: { xml: 'typing.xml', activity: 'com.example.demo.TypingActivity', taps: {} },
    loggedout: { xml: 'loggedout.xml', activity: 'com.example.demo.LoginActivity', taps: {} },
  },
};
