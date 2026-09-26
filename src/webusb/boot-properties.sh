#!/system/bin/sh
set -e

# Only apply to this guide's rooted LightOS, never restored stock or LineageOS.
[ "$(uname -r)" = "5.10.198-android12-LP3" ] || exit 0
[ "$(getprop ro.build.version.incremental)" = "00WW_1_440000" ] || exit 0
[ -z "$(getprop ro.lineage.version)" ] || exit 0

/data/adb/ksu/bin/resetprop -n ro.boot.flash.locked 1
/data/adb/ksu/bin/resetprop -n ro.boot.vbmeta.device_state locked
/data/adb/ksu/bin/resetprop -n ro.boot.verifiedbootstate green
