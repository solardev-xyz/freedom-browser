#!/usr/bin/env bash
# Builds the Windows 11 golden image for the nightly real-conditions E2E
# (#559): UEFI + Secure Boot + TPM 2.0 like a real Windows 11 PC, unattended
# install from the Enterprise evaluation ISO, then setup.ps1 at first logon.
# Re-runnable: it deletes any previous VM of the same name.
#
#   scripts/nightly-vm-e2e/provision-windows.sh
#
# Takes ~30-45 minutes. The evaluation licence runs 90 days from install;
# re-run this script before then (see README.md).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"

vm=$WINDOWS_VM
dir="$VM_DIR/$vm"
# Windows 11 Enterprise evaluation, en-US, from the Microsoft Evaluation Center.
iso_url='https://go.microsoft.com/fwlink/?linkid=2289031&clcid=0x409&culture=en-us&country=us'
iso="$STATE_DIR/images/win11-eval.iso"

ensure_ssh_key
mkdir -p "$STATE_DIR/images" "$STATE_DIR/secrets"
[ -f "$iso" ] || curl -fL -o "$iso" "$iso_url"

# The auto-logon password only ever exists inside this NAT-only VM; generate
# one per install instead of committing it.
password_file="$STATE_DIR/secrets/$vm.password"
[ -f "$password_file" ] || (umask 077; openssl rand -base64 18 | tr -d '/+=' >"$password_file")
password="$(cat "$password_file")"

virsh destroy "$vm" >/dev/null 2>&1 || true
virsh undefine "$vm" --nvram --tpm >/dev/null 2>&1 || true
sudo rm -rf "$dir"
sudo mkdir -p "$dir"

cfg="$(mktemp -d)"
trap 'rm -rf "$cfg"' EXIT
mkdir "$cfg/cd"
sed "s#@PASSWORD@#$password#g" "$here/windows/autounattend.xml" >"$cfg/cd/autounattend.xml"
cp "$here/windows/setup.ps1" "$cfg/cd/setup.ps1"
cp "$SSH_KEY.pub" "$cfg/cd/authorized_keys"
printf '%s' "$password" >"$cfg/cd/password"
genisoimage -quiet -J -r -V UNATTEND -o "$cfg/unattend.iso" "$cfg/cd"
sudo cp "$cfg/unattend.iso" "$dir/unattend.iso"
sudo cp "$iso" "$dir/win11.iso"

log "installing $vm (setup.ps1 powers it off when done)"
# --cdrom (not a cdrom --disk) so virt-install treats it as install media: it
# boots the CD first, and once Setup's first reboot ends that phase it
# restarts the domain booting from disk. That restart needs virt-install to
# still be waiting, hence the background job rather than --wait 0.
virt-install --name "$vm" --osinfo win11 \
  --vcpus 4 --memory 8192 \
  --boot "firmware=efi,firmware.feature0.name=secure-boot,firmware.feature0.enabled=yes,firmware.feature1.name=enrolled-keys,firmware.feature1.enabled=yes,nvram=$dir/install_VARS.fd" \
  --tpm backend.type=emulator,backend.version=2.0,model=tpm-crb \
  --disk "path=$dir/install.qcow2,size=80,bus=sata" \
  --cdrom "$dir/win11.iso" \
  --disk "path=$dir/unattend.iso,device=cdrom,bus=sata" \
  --network network=default,model=e1000e \
  --graphics vnc,listen=127.0.0.1 --video vga \
  --noautoconsole --wait 180 >"$cfg/virt-install.log" 2>&1 &
installer=$!

# The UEFI CD boot asks "Press any key to boot from CD or DVD" for a few
# seconds; nobody is there to press one. An arrow key, not Enter: Setup can
# reach its progress screen inside these 30 s, and there Enter or a letter
# would press Cancel.
for _ in $(seq 30); do
  virsh send-key "$vm" KEY_DOWN >/dev/null 2>&1 || true
  sleep 1
done
wait "$installer" || { cat "$cfg/virt-install.log" >&2; die "virt-install failed"; }

deadline=$((SECONDS + 2 * 3600))
until [ "$(virsh domstate "$vm")" = "shut off" ]; do
  [ $SECONDS -lt $deadline ] ||
    die "$vm still running after 2h; look at it over VNC ($(virsh vncdisplay "$vm")) and C:\\Windows\\Temp\\freedom-e2e-setup*.log"
  sleep 30
done

# The install media only matter for the install; the golden image boots from
# disk alone.
for media in win11.iso unattend.iso; do
  virsh detach-disk "$vm" "$dir/$media" --config >/dev/null 2>&1 || true
  sudo rm -f "$dir/$media"
done

# One boot to confirm auto-logon and SSH before freezing the image.
virsh start "$vm" >/dev/null
wait_for_ssh "$vm" 900 || die "$vm never answered SSH; setup.ps1 probably failed"
vm_ssh "$vm" 'Get-Content C:\e2e\provisioned.txt; node --version; git --version; (Get-Process explorer -IncludeUserName).UserName' ||
  die "provisioning check failed"

vm_freeze_golden "$vm"
log "$vm golden image ready"
