#!/usr/bin/env bash
# Builds the Ubuntu 24.04 desktop golden image for the nightly real-conditions
# E2E (#559). Re-runnable: it deletes any previous VM of the same name.
#
#   scripts/nightly-vm-e2e/provision-ubuntu.sh
#
# Takes ~15 minutes, mostly installing ubuntu-desktop-minimal.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"

vm=$UBUNTU_VM
dir="$VM_DIR/$vm"
image_url=https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
cloudimg="$STATE_DIR/images/noble-cloudimg.img"

ensure_ssh_key
mkdir -p "$STATE_DIR/images"
[ -f "$cloudimg" ] || curl -fL -o "$cloudimg" "$image_url"

virsh destroy "$vm" >/dev/null 2>&1 || true
virsh undefine "$vm" --nvram >/dev/null 2>&1 || true
sudo rm -rf "$dir"
sudo mkdir -p "$dir"

sudo qemu-img convert -O qcow2 "$cloudimg" "$dir/install.qcow2"
sudo qemu-img resize -q "$dir/install.qcow2" 40G

seed_dir="$(mktemp -d)"
trap 'rm -rf "$seed_dir"' EXIT
sed "s#@SSH_PUBKEY@#$(cat "$SSH_KEY.pub")#" "$here/ubuntu/user-data.yaml" >"$seed_dir/user-data"
printf 'instance-id: %s\nlocal-hostname: %s\n' "$vm" "$vm" >"$seed_dir/meta-data"
cloud-localds "$seed_dir/seed.iso" "$seed_dir/user-data" "$seed_dir/meta-data"
sudo cp "$seed_dir/seed.iso" "$dir/seed.iso"

log "installing $vm (cloud-init powers it off when done)"
virt-install --name "$vm" --osinfo ubuntu24.04 \
  --vcpus 4 --memory 8192 \
  --disk "path=$dir/install.qcow2,bus=virtio" \
  --disk "path=$dir/seed.iso,device=cdrom" \
  --network network=default,model=virtio \
  --graphics vnc,listen=127.0.0.1 --video virtio \
  --import --noautoconsole --wait 60

[ "$(virsh domstate "$vm")" = "shut off" ] || die "$vm did not power off within an hour"

# The seed only matters for the first boot; the golden image runs without it.
virsh detach-disk "$vm" "$dir/seed.iso" --config >/dev/null
sudo rm -f "$dir/seed.iso"

# One boot to confirm GNOME auto-logs-in before freezing the image.
virsh start "$vm" >/dev/null
wait_for_ssh "$vm" 600 || die "$vm never answered SSH"
for _ in $(seq 60); do
  vm_ssh "$vm" 'pgrep -u tester -x gnome-shell' >/dev/null 2>&1 && break
  sleep 5
done
vm_ssh "$vm" 'pgrep -u tester -x gnome-shell >/dev/null' ||
  die "no GNOME session for tester after boot"
vm_ssh "$vm" 'node --version; lsb_release -ds'

vm_freeze_golden "$vm"
log "$vm golden image ready"
