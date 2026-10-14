import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {PrinterClient, State, browserUrl, loadPrinters} from './moonraker.js';

const TOOLTIP_OFFSET = 6;

// Panel button with a spool icon and a hover tooltip below it.
const SpoolButton = GObject.registerClass(
class SpoolButton extends PanelMenu.Button {
    _init(extension, name, iconFile) {
        super._init(0.5, name, true);
        this._extension = extension;

        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            gicon: Gio.FileIcon.new(extension.dir.get_child(`icons/${iconFile}`)),
            style_class: 'system-status-icon klipper-notifier-icon',
        });
        this._box.add_child(this._icon);
        this.add_child(this._box);

        this._tooltip = new St.Label({style_class: 'dash-label klipper-notifier-tooltip'});
        this._tooltip.hide();
        Main.layoutManager.addChrome(this._tooltip);

        this.connect('notify::hover', () => this._syncTooltip());
        this.connect('destroy', () => this._tooltip.destroy());
    }

    _onClick(button, callback) {
        const click = new Clutter.ClickGesture({required_button: button});
        click.connect('recognize', () => {
            this._tooltip.hide();
            callback();
        });
        this.add_action(click);
    }

    _tooltipText() {
        return '';
    }

    _syncTooltip() {
        if (!this.hover) {
            this._tooltip.hide();
            return;
        }

        this._tooltip.text = this._tooltipText();
        this._tooltip.show();

        const [x, y] = this.get_transformed_position();
        const [width, height] = this.get_transformed_size();
        const monitor = Main.layoutManager.findMonitorForActor(this);
        const tooltipWidth = this._tooltip.width;
        const left = Math.max(monitor.x,
            Math.min(x + (width - tooltipWidth) / 2, monitor.x + monitor.width - tooltipWidth));
        this._tooltip.set_position(Math.floor(left), Math.floor(y + height + TOOLTIP_OFFSET));
    }
});

// Left click opens the printer's URL in the browser, right click opens Settings.
const PrinterButton = GObject.registerClass(
class PrinterButton extends SpoolButton {
    _init(extension, printer, client) {
        super._init(extension, printer.name, 'filament-spool-symbolic.svg');
        this._printer = printer;
        this._client = client;

        this._progress = new St.Label({
            style_class: 'klipper-notifier-progress',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._progress);

        this._onClick(Clutter.BUTTON_PRIMARY, () => {
            try {
                Gio.AppInfo.launch_default_for_uri(browserUrl(printer.url),
                    global.create_app_launch_context(0, -1));
            } catch (e) {
                logError(e, `klipper-notifier: cannot open ${printer.url}`);
            }
        });
        this._onClick(Clutter.BUTTON_SECONDARY, () => extension.openPreferences());

        client.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const {state, progress} = this._client;

        for (const s of Object.values(State))
            this._box.remove_style_class_name(`klipper-notifier-${s}`);
        this._box.add_style_class_name(`klipper-notifier-${state}`);

        const showProgress = state === State.PRINTING || state === State.PAUSED;
        this._progress.visible = showProgress;
        this._progress.text = showProgress ? `${Math.floor(progress * 100)}%` : '';

        this._syncTooltip();
    }

    _tooltipText() {
        return `${this._printer.name}\n${this._client.describe()}`;
    }
});

// Shown only while no printer is configured; any click opens Settings.
const AddPrinterButton = GObject.registerClass(
class AddPrinterButton extends SpoolButton {
    _init(extension) {
        super._init(extension, 'Add 3D printer', 'filament-spool-add-symbolic.svg');
        this._onClick(Clutter.BUTTON_PRIMARY, () => extension.openPreferences());
        this._onClick(Clutter.BUTTON_SECONDARY, () => extension.openPreferences());
    }

    _tooltipText() {
        return 'Add 3D printer';
    }
});

export default class KlipperNotifierExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._clients = new Map();
        this._buttons = [];
        this._settings.connectObject('changed::printers', () => this._syncPrinters(), this);
        this._syncPrinters();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._destroyButtons();
        for (const client of this._clients.values())
            client.destroy();
        this._clients = null;
        this._settings = null;
    }

    // Keeps connections whose url is unchanged; buttons are always rebuilt
    // so names and order follow the settings.
    _syncPrinters() {
        const printers = loadPrinters(this._settings);

        for (const [id, client] of this._clients) {
            if (!printers.some(p => p.id === id && p.url === client.url)) {
                client.destroy();
                this._clients.delete(id);
            }
        }

        this._destroyButtons();
        printers.forEach((printer, index) => {
            let client = this._clients.get(printer.id);
            if (!client) {
                client = new PrinterClient(printer.url);
                this._clients.set(printer.id, client);
                client.start();
            }
            const button = new PrinterButton(this, printer, client);
            Main.panel.addToStatusArea(`${this.uuid}:${printer.id}`, button, index, 'right');
            this._buttons.push(button);
        });

        if (printers.length === 0) {
            const button = new AddPrinterButton(this);
            Main.panel.addToStatusArea(`${this.uuid}:add`, button, 0, 'right');
            this._buttons.push(button);
        }
    }

    _destroyButtons() {
        for (const button of this._buttons)
            button.destroy();
        this._buttons = [];
    }
}
