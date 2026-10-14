import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PrinterClient, isValidUrl, loadPrinters, savePrinters} from './moonraker.js';

export default class KlipperNotifierPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;
        this._settings = this.getSettings();
        this._clients = new Map();
        this._rows = [];

        const page = new Adw.PreferencesPage({title: 'Printers', icon_name: 'printer-symbolic'});
        this._group = new Adw.PreferencesGroup({
            title: 'Printers',
            description: 'Moonraker servers shown in the top bar, one icon each.',
        });
        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'Add Printer',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        addButton.connect('clicked', () => this._editPrinter(null));
        this._group.set_header_suffix(addButton);
        page.add(this._group);
        window.add(page);

        const changedId = this._settings.connect('changed::printers', () => this._syncRows());
        window.connect('close-request', () => {
            this._settings.disconnect(changedId);
            for (const {client, handlerId} of this._clients.values()) {
                client.disconnect(handlerId);
                client.destroy();
            }
            this._clients.clear();
            return false;
        });

        this._syncRows();
    }

    _syncRows() {
        const printers = loadPrinters(this._settings);

        for (const [id, entry] of this._clients) {
            if (!printers.some(p => p.id === id && p.url === entry.client.url)) {
                entry.client.disconnect(entry.handlerId);
                entry.client.destroy();
                this._clients.delete(id);
            }
        }

        for (const row of this._rows)
            this._group.remove(row);
        this._rows = [];

        if (printers.length === 0) {
            const row = new Adw.ActionRow({
                title: 'No printers yet',
                subtitle: 'Use the + button to add a Moonraker server.',
            });
            this._addRow(row);
            return;
        }

        for (const printer of printers)
            this._addRow(this._printerRow(printer));
    }

    _addRow(row) {
        this._group.add(row);
        this._rows.push(row);
    }

    _printerRow(printer) {
        const row = new Adw.ActionRow({title: GLib.markup_escape_text(printer.name, -1)});

        let entry = this._clients.get(printer.id);
        if (!entry) {
            const client = new PrinterClient(printer.url);
            entry = {client, row: null, handlerId: 0};
            entry.handlerId = client.connect('changed', () => this._syncSubtitle(entry));
            this._clients.set(printer.id, entry);
            client.start();
        }
        entry.row = row;
        this._syncSubtitle(entry);

        const editButton = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            tooltip_text: 'Edit',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        editButton.connect('clicked', () => this._editPrinter(printer));

        const removeButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: 'Remove',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        removeButton.connect('clicked', () => this._removePrinter(printer));

        row.add_suffix(editButton);
        row.add_suffix(removeButton);
        return row;
    }

    _syncSubtitle({client, row}) {
        row.subtitle = GLib.markup_escape_text(`${client.url} — ${client.describe()}`, -1);
    }

    _editPrinter(printer) {
        const dialog = new Adw.AlertDialog({
            heading: printer ? 'Edit Printer' : 'Add Printer',
            close_response: 'cancel',
            default_response: 'save',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('save', printer ? 'Save' : 'Add');
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);

        const nameRow = new Adw.EntryRow({title: 'Name', text: printer?.name ?? ''});
        const urlRow = new Adw.EntryRow({
            title: 'Moonraker URL (e.g. 192.168.1.50:7125)',
            text: printer?.url ?? '',
        });
        const list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });
        list.append(nameRow);
        list.append(urlRow);
        dialog.set_extra_child(list);

        const validate = () => {
            const valid = nameRow.text.trim() !== '' && isValidUrl(urlRow.text);
            dialog.set_response_enabled('save', valid);
        };
        nameRow.connect('changed', validate);
        urlRow.connect('changed', validate);
        validate();

        dialog.connect('response', (_d, response) => {
            if (response !== 'save')
                return;
            const printers = loadPrinters(this._settings);
            const values = {name: nameRow.text.trim(), url: urlRow.text.trim()};
            if (printer)
                Object.assign(printers.find(p => p.id === printer.id) ?? {}, values);
            else
                printers.push({id: GLib.uuid_string_random(), ...values});
            savePrinters(this._settings, printers);
        });

        dialog.present(this._window);
    }

    _removePrinter(printer) {
        const dialog = new Adw.AlertDialog({
            heading: `Remove ${printer.name}?`,
            body: 'Its top bar icon will disappear.',
            close_response: 'cancel',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('remove', 'Remove');
        dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_d, response) => {
            if (response !== 'remove')
                return;
            savePrinters(this._settings,
                loadPrinters(this._settings).filter(p => p.id !== printer.id));
        });
        dialog.present(this._window);
    }
}
