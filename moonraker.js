// Moonraker client shared by the shell extension and the preferences window.
// Only GLib/Gio/Soup imports here: prefs.js runs outside gnome-shell.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

export const State = Object.freeze({
    READY: 'ready',
    PRINTING: 'printing',
    PAUSED: 'paused',
    ERROR: 'error',
    UNREACHABLE: 'unreachable',
});

const SUBSCRIBED_OBJECTS = {
    webhooks: ['state', 'state_message'],
    print_stats: ['state', 'message', 'filename'],
    virtual_sdcard: ['progress'],
};

const RECONNECT_MIN_SECONDS = 2;
const RECONNECT_MAX_SECONDS = 30;
const KLIPPY_POLL_SECONDS = 5;

export function loadPrinters(settings) {
    try {
        const printers = JSON.parse(settings.get_string('printers'));
        return Array.isArray(printers) ? printers : [];
    } catch {
        return [];
    }
}

export function savePrinters(settings, printers) {
    settings.set_string('printers', JSON.stringify(printers));
}

// Accepts "host", "host:7125", "http://host[:port]" or "https://..." and
// returns the Moonraker websocket endpoint. Throws on unparseable input.
export function websocketUrl(url) {
    let text = url.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text))
        text = `http://${text}`;

    const uri = GLib.Uri.parse(text, GLib.UriFlags.NONE);
    if (!uri.get_host())
        throw new Error(`No host in "${url}"`);

    const secure = ['https', 'wss'].includes(uri.get_scheme());
    return GLib.Uri.build(GLib.UriFlags.NONE, secure ? 'wss' : 'ws', null,
        uri.get_host(), uri.get_port(), '/websocket', null, null).to_string();
}

// The saved URL as typed, made openable in a browser.
export function browserUrl(url) {
    const text = url.trim();
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
}

export function isValidUrl(url) {
    try {
        websocketUrl(url);
        return true;
    } catch {
        return false;
    }
}

export const PrinterClient = GObject.registerClass({
    Signals: {'changed': {}},
}, class PrinterClient extends GObject.Object {
    constructor(url) {
        super();
        this.url = url;

        this.state = State.UNREACHABLE;
        this.message = 'Connecting…';
        this.progress = 0;
        this.filename = '';

        this._session = new Soup.Session({timeout: 10});
        this._connection = null;
        this._cancellable = null;
        this._reconnectSource = 0;
        this._reconnectDelay = RECONNECT_MIN_SECONDS;
        this._klippyPollSource = 0;
        this._nextRequestId = 1;
        this._pending = new Map();
        this._status = {};
        this._klippyState = null;
        this._klippyMessage = '';
        this._lastError = '';
        this._destroyed = false;
    }

    start() {
        this._connect();
    }

    destroy() {
        this._destroyed = true;
        this._cancellable?.cancel();
        this._clearTimers();
        this._failPending('Client destroyed');
        if (this._connection?.get_state() === Soup.WebsocketState.OPEN)
            this._connection.close(Soup.WebsocketCloseCode.NORMAL, null);
        this._connection = null;
        this._session.abort();
    }

    // One line describing the current state, for tooltips and settings rows.
    describe() {
        const percent = `${Math.floor(this.progress * 100)}%`;
        switch (this.state) {
        case State.PRINTING:
            return this.filename ? `Printing ${percent} · ${this.filename}` : `Printing ${percent}`;
        case State.PAUSED:
            return this.filename ? `Paused ${percent} · ${this.filename}` : `Paused ${percent}`;
        case State.ERROR:
            return `Error: ${this.message}`;
        case State.UNREACHABLE:
            return this.message ? `Unreachable: ${this.message}` : 'Unreachable';
        default:
            return 'Ready';
        }
    }

    _connect() {
        if (this._destroyed)
            return;

        let message;
        try {
            message = Soup.Message.new('GET', websocketUrl(this.url));
        } catch (e) {
            message = null;
            this._lastError = e.message;
        }
        if (!message) {
            this._lastError ||= `Invalid URL "${this.url}"`;
            this._update();
            return;
        }

        this._cancellable = new Gio.Cancellable();
        this._session.websocket_connect_async(message, null, null,
            GLib.PRIORITY_DEFAULT, this._cancellable, (session, result) => {
                let connection;
                try {
                    connection = session.websocket_connect_finish(result);
                } catch (e) {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    this._lastError = e.message;
                    this._scheduleReconnect();
                    return;
                }
                this._onOpen(connection);
            });
    }

    _onOpen(connection) {
        this._connection = connection;
        this._reconnectDelay = RECONNECT_MIN_SECONDS;
        this._lastError = '';

        connection.max_incoming_payload_size = 0;
        connection.keepalive_interval = 15;
        connection.keepalive_pong_timeout = 10;

        connection.connect('message', (_c, type, bytes) => {
            if (type === Soup.WebsocketDataType.TEXT)
                this._onMessage(new TextDecoder().decode(bytes.toArray()));
        });
        connection.connect('error', (_c, error) => {
            this._lastError = error.message;
        });
        connection.connect('closed', () => {
            if (this._connection !== connection)
                return;
            this._connection = null;
            this._lastError ||= 'Connection closed';
            this._failPending(this._lastError);
            this._scheduleReconnect();
        });

        this._update();
        this._refreshKlippy();
    }

    _onMessage(text) {
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            return;
        }

        if (data.id !== undefined && this._pending.has(data.id)) {
            const {resolve, reject} = this._pending.get(data.id);
            this._pending.delete(data.id);
            if (data.error)
                reject(new Error(data.error.message ?? 'Request failed'));
            else
                resolve(data.result);
            return;
        }

        switch (data.method) {
        case 'notify_status_update':
            this._mergeStatus(data.params?.[0] ?? {});
            break;
        case 'notify_klippy_ready':
            this._refreshKlippy();
            break;
        case 'notify_klippy_shutdown':
            this._klippyState = 'shutdown';
            this._update();
            this._refreshKlippy();
            break;
        case 'notify_klippy_disconnected':
            this._klippyState = 'disconnected';
            this._klippyMessage = 'Klipper disconnected';
            this._status = {};
            this._update();
            this._scheduleKlippyPoll();
            break;
        }
    }

    _call(method, params = {}) {
        return new Promise((resolve, reject) => {
            if (this._connection?.get_state() !== Soup.WebsocketState.OPEN) {
                reject(new Error('Not connected'));
                return;
            }
            const id = this._nextRequestId++;
            this._pending.set(id, {resolve, reject});
            this._connection.send_text(JSON.stringify({jsonrpc: '2.0', method, params, id}));
        });
    }

    // Reads Klipper's host state; subscribes once it is ready (or shut down,
    // where the objects still answer), otherwise polls until it changes.
    async _refreshKlippy() {
        this._clearKlippyPoll();
        try {
            const info = await this._call('printer.info');
            this._klippyState = info.state;
            this._klippyMessage = info.state_message ?? '';
        } catch (e) {
            if (!this._connection)
                return;
            this._klippyState = 'disconnected';
            this._klippyMessage = e.message;
            this._update();
            this._scheduleKlippyPoll();
            return;
        }

        if (['ready', 'shutdown'].includes(this._klippyState)) {
            try {
                const result = await this._call('printer.objects.subscribe',
                    {objects: SUBSCRIBED_OBJECTS});
                this._status = {};
                this._mergeStatus(result.status ?? {});
            } catch {
                this._scheduleKlippyPoll();
            }
        } else {
            this._scheduleKlippyPoll();
        }
        this._update();
    }

    _mergeStatus(changes) {
        for (const [name, fields] of Object.entries(changes))
            this._status[name] = {...this._status[name], ...fields};

        const webhooks = changes.webhooks;
        if (webhooks?.state !== undefined) {
            this._klippyState = webhooks.state;
            if (webhooks.state !== 'ready')
                this._scheduleKlippyPoll();
        }
        if (webhooks?.state_message !== undefined)
            this._klippyMessage = webhooks.state_message;

        this._update();
    }

    _update() {
        const printStats = this._status.print_stats ?? {};
        let state, message = '';

        if (!this._connection) {
            state = State.UNREACHABLE;
            message = this._lastError || 'Connecting…';
        } else if (this._klippyState === null || this._klippyState === 'startup') {
            state = State.UNREACHABLE;
            message = 'Klipper starting';
        } else if (this._klippyState !== 'ready') {
            state = State.ERROR;
            message = this._klippyMessage || `Klipper ${this._klippyState}`;
        } else if (printStats.state === 'error') {
            state = State.ERROR;
            message = printStats.message || 'Print failed';
        } else if (printStats.state === 'printing') {
            state = State.PRINTING;
        } else if (printStats.state === 'paused') {
            state = State.PAUSED;
        } else {
            state = State.READY;
        }

        const progress = this._status.virtual_sdcard?.progress ?? 0;
        const filename = printStats.filename ?? '';

        if (state === this.state && message === this.message &&
            progress === this.progress && filename === this.filename)
            return;

        this.state = state;
        this.message = message.trim();
        this.progress = progress;
        this.filename = filename;
        this.emit('changed');
    }

    _scheduleReconnect() {
        if (this._destroyed || this._reconnectSource)
            return;
        this._clearKlippyPoll();
        this._klippyState = null;
        this._status = {};
        this._update();

        const delay = this._reconnectDelay;
        this._reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_SECONDS);
        this._reconnectSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._reconnectSource = 0;
            this._connect();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleKlippyPoll() {
        if (this._destroyed || this._klippyPollSource)
            return;
        this._klippyPollSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, KLIPPY_POLL_SECONDS, () => {
            this._klippyPollSource = 0;
            if (this._connection)
                this._refreshKlippy();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearKlippyPoll() {
        if (this._klippyPollSource) {
            GLib.source_remove(this._klippyPollSource);
            this._klippyPollSource = 0;
        }
    }

    _clearTimers() {
        this._clearKlippyPoll();
        if (this._reconnectSource) {
            GLib.source_remove(this._reconnectSource);
            this._reconnectSource = 0;
        }
    }

    _failPending(reason) {
        for (const {reject} of this._pending.values())
            reject(new Error(reason));
        this._pending.clear();
    }
});
