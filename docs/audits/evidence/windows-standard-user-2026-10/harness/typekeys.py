#!/usr/bin/env python3
# Types a string into the VM via `virsh send-key` (PS/2 scancodes reach the
# UAC secure desktop too). Reads the text from a file so it never hits argv logs.
import subprocess, sys, time
vm, path = sys.argv[1], sys.argv[2]
text = open(path).read().rstrip('\n')
plain = {**{c: 'KEY_' + c.upper() for c in 'abcdefghijklmnopqrstuvwxyz'}, **{d: 'KEY_' + d for d in '0123456789'},
  '-': 'KEY_MINUS', '=': 'KEY_EQUAL', '[': 'KEY_LEFTBRACE', ']': 'KEY_RIGHTBRACE', ';': 'KEY_SEMICOLON', "'": 'KEY_APOSTROPHE',
  ',': 'KEY_COMMA', '.': 'KEY_DOT', '/': 'KEY_SLASH', '\\': 'KEY_BACKSLASH', '`': 'KEY_GRAVE', ' ': 'KEY_SPACE'}
shifted = {**{c.upper(): plain[c] for c in 'abcdefghijklmnopqrstuvwxyz'}, '!': 'KEY_1', '@': 'KEY_2', '#': 'KEY_3', '$': 'KEY_4',
  '%': 'KEY_5', '^': 'KEY_6', '&': 'KEY_7', '*': 'KEY_8', '(': 'KEY_9', ')': 'KEY_0', '_': 'KEY_MINUS', '+': 'KEY_EQUAL',
  '{': 'KEY_LEFTBRACE', '}': 'KEY_RIGHTBRACE', ':': 'KEY_SEMICOLON', '"': 'KEY_APOSTROPHE', '<': 'KEY_COMMA', '>': 'KEY_DOT', '?': 'KEY_SLASH', '|': 'KEY_BACKSLASH', '~': 'KEY_GRAVE'}
for c in text:
    keys = [plain[c]] if c in plain else ['KEY_LEFTSHIFT', shifted[c]]
    subprocess.run(['sg', 'libvirt', '-c', f"virsh -c qemu:///system send-key {vm} --holdtime 40 {' '.join(keys)}"], check=True, stdout=subprocess.DEVNULL)
    time.sleep(0.08)
