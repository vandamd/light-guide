# /// script
# requires-python = ">=3.11"
# dependencies = ["cryptography>=45,<48"]
# ///
"""Prepare unlocking of the tested locked ReSukiSU kernel. Never reboots or unlocks."""
import argparse
import importlib.util
import json
from pathlib import Path
import shlex
import subprocess
import sys

spec = importlib.util.spec_from_file_location("unlock", Path(__file__).with_name("light-unlock.py"))
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)


class Phone(u.Phone):
    def root(self, command):
        return self.adb("exec-out", "su -c " + shlex.quote(command))

    def check(self):
        u.require(self.adb("shell", "uname", "-r").strip() == b"5.10.198-android12-LP3",
                  "This helper is only for the tested ReSukiSU kernel.")
        return super().check()


u.Phone = Phone


def stage(folder):
    manifest = json.loads((folder / "manifest.json").read_text())
    u.require(manifest.get("format") == 1 and manifest.get("model") == u.MODEL
              and manifest.get("firmware") == u.FIRMWARE, "Unsupported backup manifest.")
    u.require(not (folder / "stage-started.json").exists(), "Staging was already attempted. Inspect the saved readback before continuing.")
    names = {"mfd-original.img", "frp-original.img", "unlock-record.bin", "mfd-expected.img", "abl_a.img", "abl_b.img"}
    u.require(set(manifest["sha256"]) == names, "Unexpected backup contents.")
    files = {name: (folder / name).read_bytes() for name in names}
    for name, data in files.items():
        u.require(u.sha256(data) == manifest["sha256"][name], "Checksum mismatch: " + name)
    phone = Phone(manifest["serial"])
    hardware_id, _ = phone.check()
    u.require(hardware_id == manifest["hardware_id"], "Hardware ID differs.")
    original, record = files["mfd-original.img"], files["unlock-record.bin"]
    u.check_original(original)
    u.verify_record(record, hardware_id)
    expected = original[:u.OFFSET] + record + original[u.OFFSET + u.BLOCK_SIZE:]
    u.require(expected == files["mfd-expected.img"], "Expected image differs.")
    u.require(phone.partition("mfd") == original, "Live mfd differs. Stop here.")
    phone.adb("push", str(folder / "unlock-record.bin"), "/data/local/tmp/light-guide-unlock.bin")
    phone.root("chown 0:0 /data/local/tmp/light-guide-unlock.bin; chmod 600 /data/local/tmp/light-guide-unlock.bin")
    print("In ReSukiSU, change Shell to a Custom root profile (uid/gid 0).")
    print("Set SELinux context: u:r:lp3_restore:s0")
    print("Add these SELinux rules:\ntype lp3_restore\nenforce lp3_restore\ntypeattribute lp3_restore mlstrustedsubject\nallow lp3_restore * * *")
    u.require(input("When saved, with your personal data backed up, type STAGE: ") == "STAGE", "Cancelled.")
    u.require(phone.root("id -Z").strip() == b"u:r:lp3_restore:s0", "The maintenance context is not active.")
    u.require(phone.partition("mfd") == original, "Live mfd changed. Stop here.")
    u.require(phone.root("cat /data/local/tmp/light-guide-unlock.bin") == record, "Uploaded record differs.")
    u.save_json(folder / "stage-started.json", {"serial": phone.serial})
    try:
        phone.root("dd if=/data/local/tmp/light-guide-unlock.bin of=/dev/block/by-name/mfd bs=4096 seek=3 count=1 conv=notrunc,fsync")
        actual = phone.partition("mfd")
        u.save(folder / "mfd-readback.img", actual)
        u.require(actual == expected, "Readback differs. Do not reboot.")
        print("Record verified. Restore Shell's Default profile in ReSukiSU now.")
        u.require(input("When restored, type DEFAULT: ") == "DEFAULT", "Restore the Default profile before continuing. Do not reboot yet.")
        u.require(phone.root("id -Z").strip() == b"u:r:ksu:s0", "Default root context is not active.")
        u.require(phone.partition("mfd") == expected, "Live mfd changed. Stop here.")
        phone.root("pm set-user-restriction --user 0 no_factory_reset 0; service call oem_lock 4 i32 1")
        u.require(phone.root("tail -c 1 /dev/block/by-name/frp") == b"\x01", "OEM unlocking is not enabled. Do not reboot.")
        u.save_json(folder / "staging-verified.json", {"sha256": u.sha256(actual), "oem_unlock_enabled": True})
    except BaseException:
        print("Staging incomplete. Keep Android running, restore Shell's Default profile and retain this backup folder.", file=sys.stderr)
        raise
    print("Complete. Restart directly into fastboot; require unlock ability 1 and permissions=flash before requesting unlock.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("prepare")
    staging = sub.add_parser("stage")
    staging.add_argument("folder", type=Path)
    args = parser.parse_args()
    if args.command == "prepare":
        u.prepare()
        print("Use light-return-unlock.py (this helper) for the stage command, not light-unlock.py.")
    else:
        stage(args.folder)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        sys.exit(f"Stopped: {error}")
