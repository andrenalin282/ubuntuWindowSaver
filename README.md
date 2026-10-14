# Ubuntu Window Saver

GNOME Shell extension that puts your windows back after a monitor comes back.

**The problem:** a monitor goes to standby, auto power-off or loses its cable. GNOME moves all its windows to the remaining monitor and shrinks them to fit. When the monitor returns, the windows stay where they are, in their small size.

**What this does:** it remembers position and size of every window per monitor. When a monitor reappears, the windows that were on it are moved back and resized. Windows you moved yourself in the meantime are left alone.

*Kurz auf Deutsch: Schaltet ein Monitor ab (Standby, Auto-Aus) und wieder ein, setzt die Erweiterung die Fenster auf Position und Größe von vorher zurück.*

## Install

```bash
git clone https://github.com/andrenalin282/ubuntuWindowSaver.git
mkdir -p ~/.local/share/gnome-shell/extensions
ln -s "$PWD/ubuntuWindowSaver" ~/.local/share/gnome-shell/extensions/ubuntuWindowSaver@andrenalin282.github.io
```

Then log out and back in (on Wayland the shell cannot be restarted in place) and enable it:

```bash
gnome-extensions enable ubuntuWindowSaver@andrenalin282.github.io
```

Remove: `gnome-extensions disable ubuntuWindowSaver@andrenalin282.github.io` and delete the link.

## Compatibility

| | |
|---|---|
| Tested | Ubuntu 26.04, GNOME Shell 50, Wayland, NVIDIA |
| Should work | GNOME Shell 45-49 (Ubuntu 24.04 / 24.10 / 25.04 / 25.10, Fedora, Arch, ...): add the version to `shell-version` in `metadata.json`. Not tested. |
| Not supported | GNOME 44 and older (no ES module extensions) |

The test ran in a headless GNOME Shell with two virtual monitors: one monitor was disabled and enabled again with three windows (floating on the removed monitor, floating on the remaining monitor and shifted by the shell, maximized). Without the extension the floating windows stayed in the wrong place and size, with it all three came back. On real hardware (LG 5120x1440 + rotated ASUS) the author confirmed that windows of the returning monitor are restored; windows on the other monitor are covered by the newest fix and the test above.

## How it works / limits

- Monitors are identified by vendor, product and serial, not by connector name (`DP-3` can become `DP-4`).
- Windows are saved 0.5 s after a move or resize. Changes during the first 2.5 s after a monitor change are ignored, because GNOME is moving windows itself then.
- Saved positions live in memory only. They are lost when GNOME Shell restarts (logout).
- Fullscreen and minimized windows are not touched.

## License

MIT, see `LICENSE`.
