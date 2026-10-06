"""Metadata-only audit. Never opens profile, database, source or runtime inputs."""
from pathlib import Path
import hashlib
import json

base = Path(__file__).resolve().parent
encode = lambda value: (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()
sha = lambda value: hashlib.sha256(value).hexdigest()
index = json.loads((base / "index.json").read_bytes())
for name, pin in index["files"].items():
    if Path(name).name != name or name == "index.json":
        raise ValueError("Unexpected archive path")
    raw = (base / name).read_bytes()
    if {"bytes": len(raw), "sha256": sha(raw)} != pin:
        raise ValueError("Archive hash mismatch: " + name)
source_bytes = (base / "source-hashes.json").read_bytes()
sources = json.loads(source_bytes)
provenance = json.loads((base / "provenance.json").read_bytes())
for mode in ["create", "cold", "legacy"]:
    name = mode + "-report.json"
    report = json.loads((base / name).read_bytes())
    ref = report["sourceSha256"]
    if ref["$ref"] != "source-hashes.json" or ref["sha256"] != sha(source_bytes):
        raise ValueError("Wrong shared source reference")
    if len(sources) != ref["entries"] or not set(ref["exclude"]) <= set(sources):
        raise ValueError("Wrong shared source selection")
    report["sourceSha256"] = {k: v for k, v in sources.items() if k not in ref["exclude"]}
    if len(report["sourceSha256"]) != ref["entriesAfterExclusion"]:
        raise ValueError("Wrong report source count")
    restored = encode(report)
    original = next(row["original"] for row in provenance["inputs"] if row["published"] == name)
    if {"bytes": len(restored), "sha256": sha(restored)} != original:
        raise ValueError("Original report reconstruction failed: " + mode)
    print(mode, sha(restored))
print("Archive hashes and three original report reconstructions match; no native replay.")
