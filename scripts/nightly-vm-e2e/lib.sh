# Shared settings and helpers for the nightly real-conditions E2E (#559).
# Sourced by the provision-* scripts and run-nightly.sh; not executable.
#
# Layout on the host:
#   $STATE_DIR/ssh/id_ed25519      key the host uses to reach every guest
#   $STATE_DIR/secrets/            per-VM generated passwords (Windows auto-logon)
#   $STATE_DIR/images/             downloaded ISOs / cloud images
#   $STATE_DIR/runs/<version>/     results copied back from each guest
#   $VM_DIR/<vm>/golden.qcow2      the provisioned clean install (read-only)
#   $VM_DIR/<vm>/run.qcow2         throwaway overlay, recreated before every run

STATE_DIR="${FREEDOM_VM_E2E_STATE:-/var/lib/freedom-nightly-e2e}"
VM_DIR="${FREEDOM_VM_E2E_VMS:-/var/lib/libvirt/images/freedom-e2e}"
SSH_KEY="$STATE_DIR/ssh/id_ed25519"
REPO_SLUG="${FREEDOM_VM_E2E_REPO:-solardev-xyz/freedom-browser}"
GUEST_USER=tester

UBUNTU_VM=freedom-e2e-ubuntu
WINDOWS_VM=freedom-e2e-win11

export LIBVIRT_DEFAULT_URI=qemu:///system

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "error: $*"; exit 1; }

ensure_ssh_key() {
  if [ ! -f "$SSH_KEY" ]; then
    mkdir -p "$(dirname "$SSH_KEY")"
    ssh-keygen -q -t ed25519 -N '' -C freedom-nightly-e2e -f "$SSH_KEY"
  fi
}

# NAT lease address of a running domain; empty until DHCP has answered. The
# newest lease for the domain's MAC: a guest can hold two (Ubuntu's netplan
# DHCP from cloud-init and then NetworkManager's, with different client IDs),
# and only the later one is the address it ends up answering on.
vm_ip() {
  local mac
  mac="$(virsh domiflist "$1" 2>/dev/null | awk '/network/ { print $5; exit }')"
  [ -n "$mac" ] || return 0
  virsh net-dhcp-leases default --mac "$mac" 2>/dev/null |
    awk '/ipv4/ { sub(/\/.*/, "", $5); print $1 " " $2 " " $5 }' |
    sort | tail -1 | cut -d' ' -f3
}

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
  -o LogLevel=ERROR -o ConnectTimeout=10 -o ServerAliveInterval=30)

vm_ssh() {
  local vm="$1"; shift
  ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "$GUEST_USER@$(vm_ip "$vm")" "$@"
}

vm_scp_to() { # vm src dest
  scp "${SSH_OPTS[@]}" -i "$SSH_KEY" -r "$2" "$GUEST_USER@$(vm_ip "$1"):$3"
}

vm_scp_from() { # vm src dest
  scp "${SSH_OPTS[@]}" -i "$SSH_KEY" -r "$GUEST_USER@$(vm_ip "$1"):$2" "$3"
}

# Waits until the guest answers SSH (boot + DHCP + sshd), up to $2 seconds.
wait_for_ssh() {
  local vm="$1" deadline=$((SECONDS + ${2:-600}))
  while [ $SECONDS -lt $deadline ]; do
    if [ -n "$(vm_ip "$vm")" ] && vm_ssh "$vm" exit 0 </dev/null 2>/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}

# Asks the guest to shut down, then pulls the plug if it has not after $2 s.
vm_shutdown() {
  local vm="$1" deadline=$((SECONDS + ${2:-180}))
  virsh shutdown "$vm" >/dev/null 2>&1 || true
  while [ $SECONDS -lt $deadline ]; do
    [ "$(virsh domstate "$vm" 2>/dev/null)" = "shut off" ] && return 0
    sleep 3
  done
  virsh destroy "$vm" >/dev/null 2>&1 || true
}

# Throws away the previous run's disk (and UEFI vars) and starts the domain
# from a fresh overlay on top of the golden image.
vm_reset_and_start() {
  local vm="$1" dir="$VM_DIR/$1"
  [ -f "$dir/golden.qcow2" ] || die "$vm has no golden image; run its provision script"
  virsh destroy "$vm" >/dev/null 2>&1 || true
  sudo rm -f "$dir/run.qcow2"
  sudo qemu-img create -q -f qcow2 -F qcow2 -b "$dir/golden.qcow2" "$dir/run.qcow2"
  if [ -f "$dir/golden_VARS.fd" ]; then
    sudo cp "$dir/golden_VARS.fd" "$dir/run_VARS.fd"
  fi
  virsh start "$vm" >/dev/null
}

# After provisioning: freeze the installed disk as the golden image and point
# the domain at a run overlay from then on.
vm_freeze_golden() {
  local vm="$1" dir="$VM_DIR/$1"
  vm_shutdown "$vm" 600
  sudo mv "$dir/install.qcow2" "$dir/golden.qcow2"
  sudo chmod 0444 "$dir/golden.qcow2"
  if [ -f "$dir/install_VARS.fd" ]; then
    sudo mv "$dir/install_VARS.fd" "$dir/golden_VARS.fd"
  fi
  virsh dumpxml --inactive "$vm" |
    sed -e "s#$dir/install.qcow2#$dir/run.qcow2#" \
        -e "s#$dir/install_VARS.fd#$dir/run_VARS.fd#" >"/tmp/$vm.xml"
  virsh define "/tmp/$vm.xml" >/dev/null
  rm -f "/tmp/$vm.xml"
}
