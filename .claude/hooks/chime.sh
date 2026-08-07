#!/usr/bin/env bash
# Stop + Notification hook: play a local Windows chime.
#
# Triggers: Stop (turn end) and Notification (permission prompts, idle).
# Behavior: synchronous PlaySync() call (~2 sec for tada.wav). Sync — not
# backgrounded — because on Git Bash for Windows a backgrounded
# `powershell.exe ... &` gets orphaned and audio output is silenced before
# the device finishes rendering it.
#
# Want a different sound? Pick any wav from C:\Windows\Media\. Louder
# alternatives: Ring01.wav, Alarm01.wav. Quieter: Windows Notify System
# Generic.wav (the previous default — too quiet to reliably notice).

set -u

powershell.exe -NoProfile -Command \
  "(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\tada.wav').PlaySync()" \
  >/dev/null 2>&1

exit 0
