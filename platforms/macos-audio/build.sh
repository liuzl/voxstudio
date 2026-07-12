#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$root/dist"
swiftc -O -framework AVFoundation "$root/vox-audio-host.swift" -o "$root/dist/vox-audio-host"
