#!/bin/sh
# Read-only inventory for the server administrator. Does not print credentials,
# change firewall rules, install software, contact app endpoints or start services.
set -eu
printf 'OS and architecture\n'
uname -sm
if [ -f /etc/os-release ]; then cat /etc/os-release; fi
printf '\nCPU and memory\n'
getconf _NPROCESSORS_ONLN
if command -v free >/dev/null; then free -h; fi
printf '\nStorage for application and Docker\n'
df -h / /opt 2>/dev/null || df -h /
if [ -d /var/lib/docker ]; then df -h /var/lib/docker; fi
printf '\nContainer engine\n'
if command -v docker >/dev/null; then
    docker --version
    docker compose version || true
    docker info --format 'Server={{.ServerVersion}} Root={{.DockerRootDir}} CPUs={{.NCPU}} Memory={{.MemTotal}}' || true
else
    printf 'Docker is not installed or not on PATH.\n'
fi
printf '\nService manager\n'
if command -v systemctl >/dev/null; then systemctl --version | head -n 1; fi
printf '\nListeners on proposed ports (80, 443, 3001)\n'
if command -v ss >/dev/null; then ss -ltn '( sport = :80 or sport = :443 or sport = :3001 )'; fi
printf '\nAlso provide: app hostname, DNS/certificate owner, existing proxy details, expected concurrent editors, off-host backup destination and admin access method.\n'
