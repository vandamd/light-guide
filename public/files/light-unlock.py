# /// script
# requires-python = ">=3.11"
# dependencies = ["cryptography>=45,<48"]
# ///
"""Experimental Light Phone III unlock preparation. Never unlocks or reboots."""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509.oid import NameOID


MODEL = "TLP301"
FIRMWARE = "00WW_1_440000"
ROOT = "/data/local/tmp/lp3-resukisu-ksud"
OFFSET, BLOCK_SIZE, MFD_SIZE = 0x3000, 0x1000, 0x20000
ABL_HASHES = {
    "abl_a": "f51fa45314960b3da6f4dfc68e4d2bbc6b821f6a3f6221f77352f4e50e7af98a",
    "abl_b": "2a983666338dd04e6b2f8c4135c1cc8ae5a65457f9e557398d04774e7a282b30",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def save(path, data):
    with path.open("xb") as output:
        os.chmod(path, 0o600)
        output.write(data)


def save_json(path, value):
    save(path, (json.dumps(value, indent=2) + "\n").encode())


class Phone:
    def __init__(self, expected_serial=None):
        result = subprocess.run(
            ["adb", "devices"], check=True, capture_output=True, text=True, timeout=15
        )
        devices = [line.split() for line in result.stdout.splitlines()[1:] if line.strip()]
        require(len(devices) == 1 and devices[0][1] == "device",
                "Connect exactly one authorised Android device and close emulators.")
        self.serial = devices[0][0]
        require(expected_serial is None or expected_serial == self.serial,
                "This backup belongs to a different phone.")

    def adb(self, *args, data=None, timeout=60):
        result = subprocess.run(
            ["adb", "-s", self.serial, *args], input=data,
            capture_output=True, timeout=timeout, check=False,
        )
        require(result.returncode == 0,
                "ADB failed: " + result.stderr.decode(errors="replace").strip())
        return result.stdout

    def root(self, command):
        return self.adb("shell", "-T", ROOT, "debug", "su",
                        data=(command + "\nexit\n").encode())

    def prop(self, name):
        return self.adb("shell", "getprop", name).decode().strip()

    def partition(self, name):
        require(name in {"mfd", "frp", *ABL_HASHES}, "Unexpected partition name.")
        return self.root("cat /dev/block/by-name/" + name)

    def check(self):
        require(self.prop("ro.product.model") == MODEL, "Unsupported phone model.")
        require(self.prop("ro.build.version.incremental") == FIRMWARE,
                "Unsupported firmware. Do not bypass this check.")
        require(self.prop("ro.boot.flash.locked") == "1",
                "The phone does not report a locked bootloader. No preparation needed.")
        require(self.root("id -u").strip() == b"0",
                "Root unavailable. Activate Prism and grant Shell superuser access.")
        self.slot = self.prop("ro.boot.slot_suffix")
        require(self.slot in ("_a", "_b"), "Invalid active slot.")
        bootloaders = {name: self.partition(name) for name in ABL_HASHES}
        for name, data in bootloaders.items():
            expected = ABL_HASHES["abl_a" if name == "abl" + self.slot else "abl_b"]
            require(sha256(data) == expected,
                    f"Unsupported {name} image. Do not bypass this check.")
        soc_id = int(self.root("cat /sys/devices/soc0/serial_number").strip())
        fuse = self.root(
            "dd if=/sys/bus/nvmem/devices/qfprom0/nvmem "
            "bs=4 skip=388 count=1 2>/dev/null"
        )
        require(len(fuse) == 4 and int.from_bytes(fuse, "little") == soc_id,
                "Hardware ID readback did not match the fuse word.")
        return soc_id, bootloaders


def check_original(original):
    require(len(original) == MFD_SIZE, "Unexpected mfd size.")
    empty = bytearray(BLOCK_SIZE)
    struct.pack_into("<I", empty, 0, 0x43655274)
    struct.pack_into("<I", empty, 0x914, 0x54724563)
    require(original[OFFSET:OFFSET + BLOCK_SIZE] == empty,
            "The authorisation area is not empty or has an unknown layout. Stop here.")


def make_record(hardware_id):
    require(0 <= hardware_id <= 0xFFFFFFFF, "Hardware ID is outside the supported range.")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Light Guide local authorisation")])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (x509.CertificateBuilder()
            .subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(days=1))
            .not_valid_after(now + dt.timedelta(days=30))
            .sign(key, hashes.SHA256()).public_bytes(serialization.Encoding.DER))
    message = f"{hardware_id:08X}".encode("ascii")
    signature = key.sign(message, padding.PKCS1v15(), hashes.SHA256())
    require(len(cert) <= 0x800, "Certificate exceeds the available space.")
    record = bytearray(BLOCK_SIZE)
    struct.pack_into("<III", record, 0, 0x43655274, 1, 1)
    record[0x00C:0x10C] = signature
    struct.pack_into("<I", record, 0x10C, len(signature))
    record[0x110:0x110 + len(cert)] = cert
    struct.pack_into("<II", record, 0x910, len(cert), 0x54724563)
    verify_record(bytes(record), hardware_id)
    return bytes(record)


def verify_record(record, hardware_id):
    require(len(record) == BLOCK_SIZE, "Unexpected record size.")
    require(struct.unpack_from("<III", record) == (0x43655274, 1, 1),
            "Record is not a one-use mode-1 authorisation.")
    require(struct.unpack_from("<I", record, 0x10C)[0] == 256,
            "Unexpected signature length.")
    length, magic = struct.unpack_from("<II", record, 0x910)
    require(0 < length <= 0x800 and magic == 0x54724563, "Invalid certificate fields.")
    require(not any(record[0x110 + length:0x910]) and not any(record[0x918:]),
            "Unexpected nonzero record padding.")
    cert = x509.load_der_x509_certificate(record[0x110:0x110 + length])
    key = cert.public_key()
    require(isinstance(key, rsa.RSAPublicKey) and key.key_size == 2048,
            "Expected an RSA-2048 certificate.")
    key.verify(record[0xC:0x10C], f"{hardware_id:08X}".encode("ascii"),
               padding.PKCS1v15(), hashes.SHA256())


def prepare():
    phone = Phone()
    print("Checking firmware, root, bootloader images and hardware ID…", flush=True)
    hardware_id, bootloaders = phone.check()
    original = phone.partition("mfd")
    check_original(original)
    frp = phone.partition("frp")
    require(len(frp) >= 4096 and frp[-1] in (0, 1), "Unexpected FRP readback.")
    record = make_record(hardware_id)
    expected = original[:OFFSET] + record + original[OFFSET + BLOCK_SIZE:]
    folder = Path("light-unlock-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S"))
    folder.mkdir(mode=0o700)
    files = {"mfd-original.img": original, "frp-original.img": frp,
             "unlock-record.bin": record, "mfd-expected.img": expected}
    files.update({name + ".img": data for name, data in bootloaders.items()})
    for name, data in files.items():
        save(folder / name, data)
    save_json(folder / "manifest.json", {
        "format": 1, "serial": phone.serial, "hardware_id": hardware_id,
        "model": MODEL, "firmware": FIRMWARE, "slot": phone.slot,
        "sha256": {name: sha256(data) for name, data in files.items()},
    })
    print(f"Prepared: {folder.resolve()}\nNo device writes were made.")
    print("This is a partition backup, not a personal-data backup.")
    print(f"Next: uv run light-unlock.py stage {folder}")


def stage(folder):
    manifest = json.loads((folder / "manifest.json").read_text())
    require(manifest.get("format") == 1 and manifest.get("model") == MODEL
            and manifest.get("firmware") == FIRMWARE, "Unsupported backup manifest.")
    require(not (folder / "stage-started.json").exists(),
            "Staging was already attempted with this backup. Inspect the result before continuing.")
    names = {"mfd-original.img", "frp-original.img", "unlock-record.bin", "mfd-expected.img",
             "abl_a.img", "abl_b.img"}
    require(set(manifest["sha256"]) == names, "Unexpected backup contents.")
    files = {name: (folder / name).read_bytes() for name in names}
    for name, data in files.items():
        require(sha256(data) == manifest["sha256"][name], f"Backup checksum mismatch: {name}")
    original, record = files["mfd-original.img"], files["unlock-record.bin"]
    check_original(original)
    verify_record(record, manifest["hardware_id"])
    expected = original[:OFFSET] + record + original[OFFSET + BLOCK_SIZE:]
    require(expected == files["mfd-expected.img"], "Expected partition image differs.")
    phone = Phone(manifest["serial"])
    print("Rechecking the connected phone and backup…", flush=True)
    hardware_id, bootloaders = phone.check()
    require(phone.slot == manifest["slot"], "Active slot differs from the backup.")
    for name, data in bootloaders.items():
        require(data == files[name + ".img"], "Bootloader differs from the backup.")
    require(hardware_id == manifest["hardware_id"], "Hardware ID differs from the backup.")
    require(phone.partition("mfd") == original, "Live mfd differs from the backup. Stop here.")
    print("This stages unlock authorisation. Confirming the later fastboot prompt erases the phone.")
    require(input("If your personal-data backup is complete, type STAGE: ") == "STAGE",
            "Cancelled. No device writes were made.")
    # Recheck after the interactive pause, immediately before making changes.
    require(phone.root("id -u").strip() == b"0", "Root access was lost.")
    require(phone.partition("mfd") == original, "Live mfd changed. Stop here.")
    save_json(folder / "stage-started.json", {"started": dt.datetime.now(dt.timezone.utc).isoformat()})
    try:
        phone.adb("push", str(folder / "unlock-record.bin"), "/data/local/tmp/light-guide-unlock.bin")
        require(phone.root("cat /data/local/tmp/light-guide-unlock.bin") == record,
                "Uploaded record did not match.")
        settings = phone.root(
            "pm set-user-restriction --user 0 no_factory_reset 0\n"
            "service call oem_lock 4 i32 1"
        )
        save(folder / "oem-unlock-result.txt", settings)
        require(phone.root("tail -c 1 /dev/block/by-name/frp") == b"\x01",
                "OEM unlocking did not become enabled.")
        phone.root(
            "dd if=/data/local/tmp/light-guide-unlock.bin of=/dev/block/by-name/mfd "
            "bs=4096 seek=3 count=1 conv=notrunc,fsync"
        )
        readback = phone.partition("mfd")
        save(folder / "mfd-readback.img", readback)
        require(readback == expected, "Partition readback did not match the intended result.")
        save_json(folder / "staging-verified.json", {
            "sha256": sha256(readback), "outside_record_unchanged": True,
            "oem_unlock_enabled": True, "boot_count": 1,
        })
    except BaseException:
        print("\nSTAGING INCOMPLETE: do not reboot. Keep root active and retain this backup folder.",
              file=sys.stderr)
        raise
    print("Staging verified. Reboot directly into the bootloader.")
    print("Run: adb reboot bootloader\nThen follow the guide's fastboot instructions.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("prepare", help="Read the phone, back up partitions and generate a local record")
    staging = commands.add_parser("stage", help="Verify the backup and stage authorisation after confirmation")
    staging.add_argument("backup_folder", type=Path)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare()
    else:
        stage(args.backup_folder)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        sys.exit(f"Stopped: {error}")
