#!/usr/bin/env python3
"""Extract proven IPv4 peers from Myotis caches; TCP reachability is not serving proof.

Ported from freedom-browser-ios a247d32, with explicit output and IPv4/port checks.
Usage: python3 scripts/myotis-seeds.py --out /tmp/mainnet-seeds.json peers.cache ...
Review and engine-probe the result before replacing a bundled list.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import ipaddress
import json
from pathlib import Path
import re
import socket
import sys


def candidates(lines):
    found = {}
    for line in lines:
        fields = line.rstrip("\n").split("\t")
        if len(fields) < 5 or "snapok" not in fields[4:] or "snapbad" in fields[4:]:
            continue
        ip, port, key = fields[:3]
        key = key.removeprefix("0x").lower()
        if not re.fullmatch(r"[0-9a-f]{128}", key) or not re.fullmatch(r"[0-9]{1,5}", port):
            continue
        try:
            ip = str(ipaddress.IPv4Address(ip.removeprefix("::ffff:")))
            port = int(port)
            if not 1 <= port <= 65535:
                continue
        except ValueError:
            continue
        found.setdefault((ip, port), f"enode://{key}@{ip}:{port}")
    return found


def reachable(item):
    address, enode = item
    try:
        with socket.create_connection(address, timeout=3):
            return enode
    except OSError:
        print(f"unreachable {address[0]}:{address[1]}", file=sys.stderr)
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("caches", nargs="+", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--no-probe", action="store_true", help="extract only; no TCP checks")
    args = parser.parse_args()
    peers = candidates(line for cache in args.caches for line in cache.read_text().splitlines())
    if args.no_probe:
        pins = list(peers.values())
    else:
        with ThreadPoolExecutor(max_workers=16) as pool:
            pins = [pin for pin in pool.map(reachable, peers.items()) if pin]
    pins = sorted(pins, key=lambda pin: pin.split("@", 1)[1])[:64]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(pins, indent=2) + "\n")
    print(f"{len(pins)} candidate seeds -> {args.out}; engine-probe before shipping")


if __name__ == "__main__":
    main()
