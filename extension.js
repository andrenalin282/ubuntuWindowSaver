// Ubuntu Window Saver - GNOME Shell extension
// Remembers every window's geometry per monitor. When a monitor disappears
// (standby, auto power-off, unplugged) GNOME moves its windows to the remaining
// monitor and shrinks them. When the monitor comes back, this extension puts the
// windows back where they were, including size.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const TAG = '[ubuntuWindowSaver]';
const SAVE_DELAY_MS = 500;   // debounce for geometry changes
const GRACE_MS = 4000;       // ignore geometry changes right after a monitor change
const RESTORE_DELAY_MS = 1200; // let mutter finish its own moves first

export default class UbuntuWindowSaver extends Extension {
    enable() {
        this._keys = [];            // stable monitor id per monitor index
        this._saved = new Map();    // window id -> {key, rx, ry, w, h, max}
        this._conns = new Map();    // window -> [signal ids]
        this._timers = new Map();   // window id -> GLib source id
        this._graceUntil = 0;
        this._restoreTimer = 0;
        this._cancellable = new Gio.Cancellable();
        this._generation = 0;

        this._monitorsId = Main.layoutManager.connect('monitors-changed',
            () => this._onMonitorsChanged());
        this._createdId = global.display.connect('window-created',
            (_d, win) => this._track(win));

        this._resolveKeys().then(keys => {
            if (!this._saved)
                return;
            this._keys = keys;
            for (const actor of global.get_window_actors())
                this._track(actor.meta_window);
        }).catch(e => console.error(TAG, e));
    }

    disable() {
        this._cancellable?.cancel();
        Main.layoutManager.disconnect(this._monitorsId);
        global.display.disconnect(this._createdId);
        for (const [win, ids] of this._conns)
            ids.forEach(id => win.disconnect(id));
        for (const id of this._timers.values())
            GLib.source_remove(id);
        if (this._restoreTimer)
            GLib.source_remove(this._restoreTimer);
        this._conns = this._timers = this._saved = this._cancellable = null;
        this._restoreTimer = 0;
    }

    _now() {
        return GLib.get_monotonic_time() / 1000;
    }

    // Stable id of every monitor (vendor|product|serial), indexed like
    // Main.layoutManager.monitors. The connector name (DP-3/DP-4) is not used
    // because it can change when a monitor comes back.
    async _resolveKeys() {
        const mons = Main.layoutManager.monitors;
        const keys = mons.map(m => `${m.width}x${m.height}@${m.x},${m.y}`);
        try {
            const reply = await new Promise((resolve, reject) => {
                Gio.DBus.session.call(
                    'org.gnome.Mutter.DisplayConfig',
                    '/org/gnome/Mutter/DisplayConfig',
                    'org.gnome.Mutter.DisplayConfig',
                    'GetCurrentState', null, null,
                    Gio.DBusCallFlags.NONE, 2000, this._cancellable,
                    (conn, res) => {
                        try {
                            resolve(conn.call_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    });
            });
            const logical = reply.get_child_value(2).deepUnpack();
            mons.forEach((m, i) => {
                const lm = logical.find(l => l[0] === m.x && l[1] === m.y);
                const spec = lm?.[5]?.[0];
                if (spec)
                    keys[i] = `${spec[1]}|${spec[2]}|${spec[3]}`;
            });
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(TAG, 'DisplayConfig unavailable, using geometry ids:', e.message);
        }
        // identical monitors without a serial would collide
        return keys.map((k, i) => keys.indexOf(k) === i ? k : `${k}#${i}`);
    }

    _trackable(win) {
        return win.get_window_type() === Meta.WindowType.NORMAL &&
            !win.skip_taskbar && !win.is_override_redirect();
    }

    _track(win) {
        if (!this._conns || this._conns.has(win) || !this._trackable(win))
            return;
        const ids = [
            win.connect('position-changed', () => this._schedule(win)),
            win.connect('size-changed', () => this._schedule(win)),
            win.connect('unmanaged', () => this._untrack(win)),
        ];
        this._conns.set(win, ids);
        this._schedule(win);
    }

    _untrack(win) {
        const ids = this._conns?.get(win);
        if (!ids)
            return;
        ids.forEach(id => win.disconnect(id));
        this._conns.delete(win);
        const wid = win.get_id();
        this._saved.delete(wid);
        const t = this._timers.get(wid);
        if (t)
            GLib.source_remove(t);
        this._timers.delete(wid);
    }

    _schedule(win) {
        if (this._now() < this._graceUntil)
            return;
        const wid = win.get_id();
        const old = this._timers.get(wid);
        if (old)
            GLib.source_remove(old);
        this._timers.set(wid, GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._timers.delete(wid);
            this._record(win);
            return GLib.SOURCE_REMOVE;
        }));
    }

    _record(win) {
        if (this._now() < this._graceUntil || win.is_fullscreen() || win.minimized)
            return;
        const mi = win.get_monitor();
        const mon = Main.layoutManager.monitors[mi];
        const key = this._keys[mi];
        if (!mon || !key)
            return;
        const r = win.get_frame_rect();
        this._saved.set(win.get_id(), {
            key,
            rx: r.x - mon.x,
            ry: r.y - mon.y,
            w: r.width,
            h: r.height,
            max: win.maximized_horizontally && win.maximized_vertically,
        });
    }

    _onMonitorsChanged() {
        // mutter is moving windows around right now: stop recording, drop timers
        this._graceUntil = this._now() + GRACE_MS;
        for (const id of this._timers.values())
            GLib.source_remove(id);
        this._timers.clear();
        const gen = ++this._generation;
        const before = this._keys;

        this._resolveKeys().then(keys => {
            if (!this._saved || gen !== this._generation)
                return;
            this._keys = keys;
            const appeared = keys.filter(k => !before.includes(k));
            console.log(TAG, `monitors: [${keys.join(', ')}] appeared: [${appeared.join(', ')}]`);
            if (appeared.length === 0)
                return;
            if (this._restoreTimer)
                GLib.source_remove(this._restoreTimer);
            this._restoreTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTORE_DELAY_MS, () => {
                this._restoreTimer = 0;
                this._restore();
                return GLib.SOURCE_REMOVE;
            });
        }).catch(e => console.error(TAG, e));
    }

    _restore() {
        this._graceUntil = this._now() + GRACE_MS;
        let n = 0;
        for (const [win] of this._conns) {
            const s = this._saved.get(win.get_id());
            // every window whose monitor is present again, not only those of the
            // monitor that came back: the layout around it changed as well
            if (!s || !this._keys.includes(s.key) || win.is_fullscreen())
                continue;
            const mi = this._keys.indexOf(s.key);
            const mon = Main.layoutManager.monitors[mi];
            if (!mon)
                continue;
            const r = win.get_frame_rect();
            const x = mon.x + s.rx;
            const y = mon.y + s.ry;
            if (win.get_monitor() === mi &&
                Math.abs(r.x - x) < 3 && Math.abs(r.y - y) < 3 &&
                Math.abs(r.width - s.w) < 3 && Math.abs(r.height - s.h) < 3)
                continue;
            try {
                if (s.max) {
                    if (win.get_monitor() !== mi)
                        win.move_to_monitor(mi);
                } else {
                    if (win.maximized_horizontally || win.maximized_vertically)
                        win.unmaximize();
                    win.move_resize_frame(false, x, y, s.w, s.h);
                }
                n++;
            } catch (e) {
                console.warn(TAG, 'restore failed:', e.message);
            }
        }
        console.log(TAG, `restored ${n} window(s)`);
    }
}
