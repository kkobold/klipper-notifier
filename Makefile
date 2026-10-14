UUID = klipper-notifier@kkobold
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCES = metadata.json extension.js prefs.js moonraker.js stylesheet.css

.PHONY: schemas install uninstall pack clean

schemas:
	glib-compile-schemas --strict schemas/

install: schemas
	mkdir -p $(INSTALL_DIR)
	cp -r $(SOURCES) icons schemas $(INSTALL_DIR)/

uninstall:
	rm -rf $(INSTALL_DIR)

pack:
	gnome-extensions pack --force --extra-source=moonraker.js --extra-source=icons --extra-source=LICENSE .

clean:
	rm -f schemas/gschemas.compiled $(UUID).shell-extension.zip
