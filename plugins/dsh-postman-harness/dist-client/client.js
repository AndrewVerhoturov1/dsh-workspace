window.__ModuleLoader__.load({
	id: "dsh-postman-harness",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region lib/ptc-lab-browser-runtime.js
		const PTC_LAB_DEFAULT_PROGRAM = `console.log('simulation only');\nconst report = await tools.plan({intent: 'inspect'});\nreturn {role: 'leader', report};`;
		var PtcLabBrowserRuntime = class {
			constructor() {
				this.worker = void 0;
				this.cancelCurrent = void 0;
				this.runId = 0;
			}
			run({ role, program, signal, timeoutMs = 5e3 }) {
				if (this.worker) return Promise.reject(/* @__PURE__ */ new Error("A lab run is already active"));
				if (typeof Worker !== "function") return Promise.reject(/* @__PURE__ */ new Error("Browser Worker is unavailable"));
				const worker = new Worker(new URL("/plugins/dsh-postman-harness/assets/ptc-lab-browser-worker.mjs", window.location.origin), {
					type: "module",
					name: "ptc-lab-quickjs"
				});
				this.worker = worker;
				const runId = ++this.runId;
				return new Promise((resolve) => {
					let settled = false;
					const requestedTimeout = Number(timeoutMs);
					const boundedTimeout = Number.isFinite(requestedTimeout) ? Math.max(1, Math.min(requestedTimeout, 3e4)) : 5e3;
					let watchdog;
					const finish = (result) => {
						if (settled) return;
						settled = true;
						clearTimeout(watchdog);
						signal?.removeEventListener("abort", abort);
						worker.terminate();
						if (this.worker === worker) this.worker = void 0;
						if (this.cancelCurrent === abort) this.cancelCurrent = void 0;
						resolve(result);
					};
					const abort = () => {
						try {
							worker.postMessage({
								type: "abort",
								runId
							});
						} catch {}
						finish({
							logs: [],
							error: {
								kind: "abort",
								message: "Execution aborted"
							}
						});
					};
					watchdog = setTimeout(() => finish({
						logs: [],
						error: {
							kind: "timeout",
							message: "QuickJS worker did not respond before its deadline"
						}
					}), boundedTimeout + 250);
					this.cancelCurrent = abort;
					worker.onmessage = (event) => {
						if (event.data?.type === "done" && event.data.runId === runId) finish(event.data);
					};
					worker.onerror = (event) => {
						event.preventDefault();
						finish({
							logs: [],
							error: {
								kind: "worker",
								message: event.message || "QuickJS worker failed"
							}
						});
					};
					signal?.addEventListener("abort", abort, { once: true });
					if (signal?.aborted) {
						abort();
						return;
					}
					worker.postMessage({
						type: "run",
						runId,
						role,
						program,
						timeoutMs: boundedTimeout
					});
				});
			}
			abort() {
				this.cancelCurrent?.();
			}
			dispose() {
				this.abort();
			}
		};
		//#endregion
		//#region lib/ptc-lab-panel.js
		const ROLE_NAMES = [
			"leader",
			"worker",
			"bridge"
		];
		function PtcLabPanel() {
			const [role, setRole] = (0, react.useState)("leader");
			const [program, setProgram] = (0, react.useState)(PTC_LAB_DEFAULT_PROGRAM);
			const [outcome, setOutcome] = (0, react.useState)(null);
			const [running, setRunning] = (0, react.useState)(false);
			const [runtime] = (0, react.useState)(() => new PtcLabBrowserRuntime());
			const [controller, setController] = (0, react.useState)(null);
			(0, react.useEffect)(() => () => runtime.dispose(), [runtime]);
			const run = async () => {
				const nextController = new AbortController();
				setController(nextController);
				setRunning(true);
				setOutcome(null);
				try {
					setOutcome(await runtime.run({
						role,
						program,
						signal: nextController.signal
					}));
				} catch (error) {
					setOutcome({
						logs: [],
						error: {
							kind: "exception",
							message: error instanceof Error ? error.message : String(error)
						}
					});
				} finally {
					setController(null);
					setRunning(false);
				}
			};
			return react.default.createElement("section", { "data-ptc-lab": true }, react.default.createElement("h2", null, "PTC Lab — только лаборатория"), react.default.createElement("p", { className: "ptc-lab-warning" }, "Экспериментальная симуляция. Не рабочие роли; не настоящий Postman. Доступны только демонстрационные JSON-вызовы."), react.default.createElement("label", null, "Роль", react.default.createElement("select", {
				value: role,
				disabled: running,
				onChange: (event) => setRole(event.target.value)
			}, ROLE_NAMES.map((name) => react.default.createElement("option", {
				key: name,
				value: name
			}, name)))), react.default.createElement("label", null, "Программа JavaScript", react.default.createElement("textarea", {
				spellCheck: false,
				value: program,
				onChange: (event) => setProgram(event.target.value),
				rows: 9
			})), react.default.createElement("div", { className: "ptc-lab-actions" }, react.default.createElement("button", {
				type: "button",
				disabled: running,
				onClick: run
			}, "Запустить"), react.default.createElement("button", {
				type: "button",
				disabled: !running,
				onClick: () => controller?.abort()
			}, "Прервать")), running && react.default.createElement("p", { role: "status" }, "QuickJS выполняет программу…"), outcome && react.default.createElement("div", { "aria-live": "polite" }, react.default.createElement("strong", null, "Результат выполнения (только демонстрация)"), outcome.result !== void 0 && react.default.createElement("pre", null, JSON.stringify(outcome.result, null, 2)), !!outcome.logs?.length && react.default.createElement("div", null, react.default.createElement("strong", null, "Журнал"), react.default.createElement("pre", null, JSON.stringify(outcome.logs, null, 2))), outcome.error && react.default.createElement("div", { role: "alert" }, react.default.createElement("strong", null, `Ошибка · ${outcome.error.kind}`), react.default.createElement("pre", null, outcome.error.message))));
		}
		//#endregion
		//#region lib/client.js
		const inject = ["slots"];
		function apply(ctx) {
			ctx.effect(() => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "postman-ptc-lab",
				inject: () => ({})
			}, ({ wide }) => wide ? react.default.createElement(PtcLabPanel) : null), "postman-harness: isolated PTC lab");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
