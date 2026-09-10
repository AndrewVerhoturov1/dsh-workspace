window.__ModuleLoader__.load({
	id: "dsh-restart-web",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var h = react.createElement;
		var styleId = "dsh-restart-web-styles";
		var styled = false;
		function ensureStyles() {
			if (styled) return;
			styled = true;
			var el = document.createElement("style");
			el.id = styleId;
			el.textContent = ".dsh-rst-page{padding:20px 24px;max-width:480px}.dsh-rst-page h3{margin:0 0 8px;font-size:16px;font-weight:600}.dsh-rst-page p{margin:0 0 16px;font-size:13px;line-height:1.6;opacity:.7}.dsh-rst-card{border:1px solid rgba(128,128,128,.2);border-radius:10px;padding:16px}.dsh-rst-card-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.dsh-rst-card-txt{font-size:14px;font-weight:500}.dsh-rst-btn{padding:8px 20px;border-radius:7px;border:1px solid #ef4444;background:#ef4444;color:#fff;cursor:pointer;font-size:13px;font-weight:500;white-space:nowrap}.dsh-rst-btn:hover{background:#dc2626}.dsh-rst-btn:disabled{opacity:.7;cursor:default}.dsh-rst-confirm{margin-top:14px;padding:14px;border-radius:8px;background:rgba(128,128,128,.08);border:1px solid rgba(239,68,68,.3);display:flex;flex-direction:column;gap:12px}.dsh-rst-confirm p{margin:0;font-size:13px;line-height:1.5}.dsh-rst-confirm-btns{display:flex;gap:10px}.dsh-rst-confirm-btns button{flex:1;padding:7px 0;border-radius:6px;cursor:pointer;font-size:13px;border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit}.dsh-rst-go{background:#ef4444!important;color:#fff!important;border-color:#ef4444!important}.dsh-rst-spin{display:inline-block;animation:dsh-rst-rot 1s linear infinite}@keyframes dsh-rst-rot{from{transform:rotate(0)}to{transform:rotate(360deg)}}";
			document.head.appendChild(el);
		}
		function RestartSection() {
			react.useEffect(function () { ensureStyles(); }, []);
			var st = react.useState("idle");
			var current = st[0];
			var setState = st[1];
			function waitForReady(reload) {
				var startedAt = Date.now();
				var sawOffline = false;
				function probe() {
					fetch("/?dsh-restart-probe=" + Date.now(), { cache: "no-store" }).then(function (response) {
						if (!response.ok) throw new Error("Harness is not ready");
						return response.text();
					}).then(function (html) {
						var assets = html.match(/\/plugins\/[^"' ]+\/client\.js\?rev=[^"' ]+/g) || [];
						if (!assets.length) throw new Error("Harness plugin manifest is not ready");
						return Promise.all(assets.map(function (asset) {
							return fetch(asset + "&dsh-restart-probe=" + Date.now(), { cache: "no-store" });
						}));
					}).then(function (responses) {
						if (responses.some(function (response) { return !response.ok; })) throw new Error("Harness plugins are not ready");
						if (sawOffline || Date.now() - startedAt >= 15000) {
							setTimeout(reload, 750);
							return;
						}
						setTimeout(probe, 750);
					}).catch(function () {
						sawOffline = true;
						setTimeout(probe, 1000);
					});
				}
				setTimeout(probe, 1500);
			}
			function doRestart() {
				setState("restarting");
				fetch("/api/dsh-restart", { method: "POST" }).then(function (response) {
					if (!response.ok) throw new Error("Restart request failed");
					waitForReady(function () { try { window.location.reload(); } catch (_e) {} });
				}).catch(function () {
					setState("idle");
				});
			}
			var card = h("div", { className: "dsh-rst-card" }, h("div", { className: "dsh-rst-card-row" }, h("span", { className: "dsh-rst-card-txt" }, "DeepSeek Harness process"), h("button", { className: "dsh-rst-btn", onClick: function () { setState("confirming"); } }, "Restart")));
			if (current === "restarting") return h("div", { className: "dsh-rst-page" }, h("h3", null, "Restart DeepSeek Harness"), h("div", { className: "dsh-rst-card" }, h("span", { className: "dsh-rst-card-txt" }, h("span", { className: "dsh-rst-spin" }, "↻"), " Restarting... waiting for the server and plugins to become ready")));
			if (current === "confirming") return h("div", { className: "dsh-rst-page" }, h("h3", null, "Restart DeepSeek Harness"), h("p", null, "Click the Restart button below to restart the DSH process."), card, h("div", { className: "dsh-rst-confirm" }, h("p", null, "Restart DeepSeek Harness now?"), h("div", { className: "dsh-rst-confirm-btns" }, h("button", { className: "dsh-rst-go", onClick: doRestart }, "Confirm restart"), h("button", { onClick: function () { setState("idle"); } }, "Cancel"))));
			return h("div", { className: "dsh-rst-page" }, h("h3", null, "Restart DeepSeek Harness"), h("p", null, "Click the Restart button below to restart the DSH process."), card);
		}
		function apply(ctx) {
			ctx.slots.inject("settings.section", function () { ctx.slots.register({ name: "settings.section", id: "dsh-restart", order: 200, label: "Restart" }, RestartSection); });
		}
		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
