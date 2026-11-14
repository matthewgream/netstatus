
##

TARGET=netstatusd
HOSTNAME:=$(shell hostname)
CFG_SRC:=$(if $(wildcard netstatus.$(HOSTNAME).cfg),netstatus.$(HOSTNAME).cfg,netstatus.cfg)
# the command-line tools, run from here (see README); port-status.js and poe-mikrotik.js are also the daemon's readers
TOOLS=port-status.js poe-mikrotik.js wifi-status.js wifi-mikrotik.js wifi-edimax.js wifi-channel.js wifi-ft.js devices-known.js
LIB=port-status.js poe-mikrotik.js

##

all: check

node_modules: package.json
	npm install --no-audit --no-fund --ignore-scripts
	touch node_modules
check: $(TARGET) $(TOOLS)
	@for f in $^; do node --check $$f || exit 1; done
	@echo "syntax OK"
format:
	prettier --write $(TARGET) $(TOOLS)
# one round of polling, printed rather than published
test: $(TARGET) node_modules
	./$(TARGET) $(CFG_SRC) --once

.PHONY: all check format test

##

INSTALL=netstatus
DIR_INSTALL=/usr/local/bin
DIR_LIB=/usr/local/lib/netstatus
DIR_DEFAULT=/etc/default
DIR_SYSTEMD=/etc/systemd/system
define install_service_systemd
	-systemctl stop $(2) 2>/dev/null || true
	install -m 644 $(1).service $(DIR_SYSTEMD)/$(2).service
	systemctl daemon-reload
	systemctl enable $(2)
	systemctl start $(2) || echo "Warning: Failed to start $(2)"
endef
# the daemon, the readers it uses and its npm dependencies, in DIR_LIB
install_target: $(TARGET) $(LIB) package.json package-lock.json
	install -d $(DIR_LIB)
	install -m 755 $(TARGET) $(LIB) $(DIR_LIB)/
	install -m 644 package.json package-lock.json $(DIR_LIB)/
	cd $(DIR_LIB) && npm ci --omit=dev --no-audit --no-fund --ignore-scripts
	ln -sf $(DIR_LIB)/$(TARGET) $(DIR_INSTALL)/$(TARGET)
install_default: $(CFG_SRC)
	@echo "installing config from $(CFG_SRC)"
	install -m 644 $(CFG_SRC) $(DIR_DEFAULT)/$(INSTALL)
install_service: $(INSTALL).service
	$(call install_service_systemd,$(INSTALL),$(INSTALL))
install: check install_target install_default install_service
restart:
	systemctl restart $(INSTALL)
status:
	@systemctl --no-pager --lines=0 status $(INSTALL) || true
	@journalctl -u $(INSTALL) -n 20 --no-pager -o cat
.PHONY: install install_target install_default install_service
.PHONY: restart status

##
