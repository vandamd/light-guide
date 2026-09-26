export const MANAGER = {
  filename: 'ReSukiSU-rc3.apk',
  versionCode: 35171,
};

export const FILES = {
  "lineage-boot.img": { size: 100663296, sha256: "8323635a1d0314ff82310801b098aef38640330644bf7ed91e2da65b91a5529b" },
  "lineage-vbmeta.img": { size: 65536, sha256: "1f20719a7f656ce2ad10b2b8753e526a492c18276dff989afbc002a6443918c2" },
  "stock-boot.img": {
    "size": 100663296,
    "sha256": "ae2f5a99048d8ed2c9847b14a4d09d385c8dbfc8c849d57d9abb9d544c974868"
  },
  "stock-vbmeta.img": {
    "size": 65536,
    "sha256": "a5ace87e18ab4670190eba4266529512249b5cab50432e2c4fc049dc54b576ce"
  },
  "resukisu-boot.img": {
    "size": 100663296,
    "sha256": "820e91e882af25a9174dd23a4caea70412fdf97159f951ab0df9b2e531760fe9"
  },
  "resukisu-vbmeta.img": {
    "size": 65536,
    "sha256": "71a2984f6c1c8c55736dff3a84b55aa40dae20df9381e9fc3f0a0c887715d847"
  },
  "owner-key.avbpubkey": {
    "size": 1032,
    "sha256": "3559eec1150fec2b2e574e9d10cae6af4a1b67684609143cb5230ad11f8db2bd"
  },
  [MANAGER.filename]: {
    "size": 9379362,
    "sha256": "25657bc449439687608fffa04b4b586de90fc405e3dc6217bd997fc71ba0a0a1"
  }
};

const UNCHANGED = {
  "/dev/block/by-name/vbmeta_system": "11193dc6e558be6191a4179f68594f7046ce1120974d93ec9628c19d3d50a42d",
  "/dev/block/by-name/recovery": "312394e9a7f8338f043a2c9e09b813bdd0a86f37aaf40661f11dda6c0e759691",
  "/dev/block/by-name/vendor_boot": "1931b2b0e1a9fba0898cb674adea55105a54c67cb8596a8a97a90f85f9f337a9",
  "/dev/block/by-name/dtbo": "f420402c060b476798d89e7963dc2c81968cc4026fab2332965d38cc35981be1",
  "/dev/block/mapper/system": "d77a67343e42634c8cd4ea39258840d6a6adb7f218ed311febe0c9e7ebabb8c8",
  "/dev/block/mapper/system_ext": "be1850f786b70bf88a2b3e0407759f1d0fb4925e4bd1ed5946f89f0dbd856878",
  "/dev/block/mapper/product": "e3559c11a2bf9f9f0fdf04516a4811f24c709dcddeb2227f5227fa5361837435",
  "/dev/block/mapper/vendor": "37e7c79274606dac4dbbed8ce43433cb0f61b32c2c80c469e98e3d094d34d471",
  "/dev/block/mapper/odm": "243dca47795e5ce3082d3bfa09ef2e15d2211a2006db3810610d920ea9681620",
  "/dev/block/mapper/vendor_dlkm": "0cedce1429f9200682f054378ee1bda32ce289074099734eb5d45e38c32302e3"
};

export function unchangedPartitions(slot) {
  if (!['a', 'b'].includes(slot)) throw new Error('Invalid active slot.');
  return Object.fromEntries(Object.entries(UNCHANGED).map(([path, hash]) => [`${path}_${slot}`, hash]));
}

// Both slots use the same images; active-slot firmware hashes must match before writing.
export const RELEASE_SLOTS = ['a', 'b'];

export const LINEAGE_VERSION = "23.2-20260524-VANILLA-EXT4-GSI";

export const TARGETS = {
  lineage: { label: "LineageOS 23.2 + ReSukiSU + SUSFS", boot: "lineage-boot.img", vbmeta: "lineage-vbmeta.img", kernel: "5.10.198-android12-LP3" },
  custom: { label: 'LightOS + ReSukiSU + SUSFS', boot: 'resukisu-boot.img', vbmeta: 'resukisu-vbmeta.img', kernel: '5.10.198-android12-LP3', digest: '55eccdeff5a645aa9ae6a88c9c38ae6e2a2a648560bc92eb205f4c343be0a9e6', colour: 'yellow' },
  stock: { label: 'Stock LightOS', boot: 'stock-boot.img', vbmeta: 'stock-vbmeta.img', kernel: '5.10.198-android12-9-g1a2636627c17', digest: 'b132b505a3a678677ca860de48ebb7593c99d83e8626de903cdca55002861e69', colour: 'green' },
};
