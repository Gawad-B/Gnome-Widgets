UUID    := desk-widgets@gawad-b.github.io
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: build typecheck test install uninstall package clean smoke run logs

build:
	npm run build

typecheck:
	npm run typecheck

test:
	npm test

# Installs into the real session's extensions dir. The extension only runs there once the
# user enables it (gnome-extensions enable $(UUID)) and logs out/in.
install: build
	rm -rf $(EXT_DIR)
	mkdir -p $(EXT_DIR)
	cp -r dist/. $(EXT_DIR)/

uninstall:
	rm -rf $(EXT_DIR)

package: build
	mkdir -p packages
	rm -f packages/$(UUID).zip
	cd dist && zip -qr ../packages/$(UUID).zip .

clean:
	-tools/devshell.sh stop
	rm -rf dist packages .devshell

# Headless smoke check: start the isolated shell and print the extension state.
smoke: build
	tools/devshell.sh start

# Visible nested shell for manual testing (needs: sudo dnf install mutter-devkit).
run: build
	tools/devshell.sh start --devkit

logs:
	tools/devshell.sh log
