#!/bin/sh
# A WSL 2 utility VM in one privileged container: its network namespace is the one every WSL distro
# shares, and each "distro" is a mount + PID namespace of its own with a fresh /run, its own
# container storage and its own network configs. Stopping a distro kills its PID namespace, which
# is what `wsl --terminate` does: the processes and /run go, the shared netns and its rules stay.
set -eu

cmd=$1
shift

distro_pid() {
	cat "/distros/$1/pid"
}

in_distro() {
	name=$1
	shift
	nsenter --target "$(distro_pid "$name")" --mount --pid -- "$@"
}

case "$cmd" in
setup)
	driver=$1
	# iptables-nft for Docker's chain in both, and for netavark itself in the iptables one.
	dnf -y -q install iptables-nft >/dev/null
	if [ "$driver" = iptables ]; then
		mkdir -p /etc/containers/containers.conf.d
		# What Podman's WSL machine init writes on 5.x ("Force use of iptables on Windows WSL").
		printf '[network]\nfirewall_driver="iptables"\n' >/etc/containers/containers.conf.d/50-wsl-iptables.conf
	fi
	# fuse-overlayfs inside Docker Desktop's VM fails every exec with EINVAL; vfs works anywhere.
	printf '[storage]\ndriver = "vfs"\nrunroot = "/run/containers/storage"\ngraphroot = "/var/lib/containers/storage"\n' >/etc/containers/storage.conf
	for name in openbot person; do
		mkdir -p "/distros/$name/storage" "/distros/$name/networks"
	done
	;;
start)
	name=$1
	rm -f "/distros/$name/pid"
	unshare --mount --pid --fork --propagation private sh -c '
		set -e
		name=$1
		mkdir -p /var/lib/containers/storage /etc/containers/networks
		mount -t tmpfs tmpfs /run
		mount -t tmpfs tmpfs /dev/shm
		mount --bind "/distros/$name/storage" /var/lib/containers/storage
		mount --bind "/distros/$name/networks" /etc/containers/networks
		read -r pid _ </proc/self/stat
		echo "$pid" >"/distros/$name/pid.tmp"
		mv "/distros/$name/pid.tmp" "/distros/$name/pid"
		exec sleep infinity
	' distro "$name" >/dev/null 2>&1 &
	while [ ! -s "/distros/$name/pid" ]; do sleep 0.1; done
	;;
stop)
	name=$1
	kill -9 "$(distro_pid "$name")"
	while kill -0 "$(distro_pid "$name")" 2>/dev/null; do sleep 0.1; done
	sleep 1
	;;
podman)
	name=$1
	shift
	in_distro "$name" podman "$@"
	;;
sh)
	name=$1
	shift
	in_distro "$name" sh -c "$1"
	;;
curl)
	curl -s -m "${2:-5}" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/" || true
	;;
*)
	echo "unknown: $cmd" >&2
	exit 2
	;;
esac
