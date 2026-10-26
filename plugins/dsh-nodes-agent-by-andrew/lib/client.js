window.__ModuleLoader__.load({
 id: "dsh-nodes-agent-by-andrew",
 factory: (require) => {
 const module = { exports: {} };
 const EDITOR_HTML = "<div class=\"app-shell\" id=\"appShell\">\r\n    <header class=\"topbar\">\r\n      <div class=\"brand-block\">\r\n        <div class=\"brand-mark\" aria-hidden=\"true\">NA</div>\r\n        <div>\r\n          <div class=\"brand-title\">NodesAgent_by_Andrew</div>\r\n          <div class=\"brand-subtitle\" data-i18n=\"prototypeLabel\">Native Postman Team Editor</div>\r\n        </div>\r\n      </div>\r\n\r\n      <div class=\"team-block\">\r\n        <label class=\"sr-only\" for=\"teamName\" data-i18n=\"teamName\">Team name</label>\r\n        <input id=\"teamName\" class=\"team-name\" type=\"text\" maxlength=\"64\" value=\"Software Team\" autocomplete=\"off\">\r\n        <span class=\"save-state\" id=\"saveState\" data-i18n=\"localDraft\">Local draft</span>\r\n      </div>\r\n\r\n      <div class=\"toolbar-actions\">\r\n        <div class=\"toolbar-cluster utility\">\r\n          <div class=\"segmented compact\" role=\"group\" aria-label=\"Language\">\r\n            <button type=\"button\" class=\"segment is-active\" data-locale-action=\"en-US\">EN</button>\r\n            <button type=\"button\" class=\"segment\" data-locale-action=\"ru-RU\">RU</button>\r\n          </div>\r\n          <select id=\"teamPicker\" class=\"nodes-team-picker\" aria-label=\"Saved teams\"></select>\r\n          <button type=\"button\" class=\"button subtle\" id=\"loadDemoButton\" data-i18n=\"loadDemo\">Load</button>\r\n          <button type=\"button\" class=\"button subtle\" id=\"resetButton\" data-i18n=\"reset\">New</button>\r\n        </div>\r\n        <div class=\"toolbar-cluster\">\r\n          <button type=\"button\" class=\"button\" id=\"saveButton\" data-i18n=\"save\">Save</button>\r\n          <button type=\"button\" class=\"button\" id=\"saveAsButton\" data-i18n=\"saveAs\">Save As</button>\r\n          <button type=\"button\" class=\"button validate-button\" id=\"validateButton\" data-validation=\"none\"><span id=\"validateButtonLabel\" data-i18n=\"validate\">Validate</span><span class=\"validate-button-status\" id=\"validateButtonStatus\"></span></button>\r\n        </div>\r\n        <div class=\"toolbar-cluster\">\r\n          <button type=\"button\" class=\"button primary\" id=\"startButton\" data-i18n=\"start\">Start</button>\r\n          <button type=\"button\" class=\"button\" id=\"pauseButton\" data-i18n=\"pause\" hidden>Pause</button>\r\n          <button type=\"button\" class=\"button\" id=\"resumeButton\" data-i18n=\"resume\" hidden>Resume</button>\r\n          <button type=\"button\" class=\"button danger\" id=\"stopButton\" data-i18n=\"stop\" hidden>Stop</button>\r\n        </div>\r\n      </div>\r\n    </header>\r\n\r\n    <main class=\"workspace\" id=\"workspace\">\r\n      <section class=\"editor-pane\" aria-label=\"Agent team editor\">\r\n        <div class=\"canvas-toolbar\">\r\n          <button type=\"button\" class=\"icon-button label-button\" id=\"addNodeButton\" title=\"Add AgentNode\">\r\n            <span class=\"icon\">+</span><span data-i18n=\"addAgent\">Agent</span>\r\n          </button>\r\n          <div class=\"toolbar-divider\"></div>\r\n          <div class=\"segmented\" role=\"group\" aria-label=\"Edge mode\">\r\n            <button type=\"button\" class=\"segment is-active\" data-edge-mode=\"select\" data-i18n=\"selectMode\">Select</button>\r\n            <button type=\"button\" class=\"segment\" data-edge-mode=\"authority\" data-i18n=\"authority\">Authority</button>\r\n            <button type=\"button\" class=\"segment\" data-edge-mode=\"communication\" data-i18n=\"communication\">Communication</button>\r\n          </div>\r\n          <div class=\"segmented communication-direction-control\" id=\"communicationDirectionControl\" role=\"group\" aria-label=\"Communication direction\" hidden>\r\n            <button type=\"button\" class=\"segment is-active\" data-communication-direction=\"bidirectional\" title=\"Bidirectional\">↔<span data-i18n=\"communicationBidirectional\">Both</span></button>\r\n            <button type=\"button\" class=\"segment\" data-communication-direction=\"oneway\" title=\"One-way\">→<span data-i18n=\"communicationOneWay\">One-way</span></button>\r\n          </div>\r\n          <div class=\"toolbar-divider\"></div>\r\n          <button type=\"button\" class=\"icon-button\" id=\"zoomOutButton\" title=\"Zoom out\">−</button>\r\n          <span class=\"zoom-readout\" id=\"zoomReadout\">100%</span>\r\n          <button type=\"button\" class=\"icon-button\" id=\"zoomInButton\" title=\"Zoom in\">+</button>\r\n          <button type=\"button\" class=\"icon-button label-button\" id=\"fitButton\" title=\"Fit view\"><span class=\"fit-icon\">⌗</span><span data-i18n=\"fitView\">Fit</span></button>\r\n          <div class=\"canvas-settings-wrap\">\r\n            <button type=\"button\" class=\"icon-button label-button canvas-settings-button\" id=\"canvasSettingsButton\" aria-expanded=\"false\"><span aria-hidden=\"true\">⚙</span><span data-i18n=\"canvasSettings\">Canvas</span></button>\r\n            <div class=\"canvas-settings-popover\" id=\"canvasSettingsPopover\" hidden>\r\n              <div class=\"canvas-settings-title\"><span data-i18n=\"canvasSettingsTitle\">Canvas settings</span></div>\r\n              <div class=\"canvas-settings-section\">\r\n                <div class=\"canvas-settings-row\">\r\n                  <span class=\"canvas-settings-label\"><span data-i18n=\"showGrid\">Show grid</span><small data-i18n=\"showGridHelp\">Visual coordinate grid</small></span>\r\n                  <input id=\"gridVisibleInput\" type=\"checkbox\">\r\n                </div>\r\n                <div class=\"canvas-settings-row\">\r\n                  <span data-i18n=\"gridStyle\">Grid style</span>\r\n                  <select id=\"gridStyleSelect\"><option value=\"dots\" data-i18n=\"gridDots\">Dots</option><option value=\"lines\" data-i18n=\"gridLines\">Lines</option></select>\r\n                </div>\r\n                <div class=\"canvas-settings-row\">\r\n                  <span data-i18n=\"gridSize\">Grid step</span>\r\n                  <select id=\"gridSizeSelect\"><option value=\"12\">12 px</option><option value=\"18\">18 px</option><option value=\"24\">24 px</option><option value=\"36\">36 px</option></select>\r\n                </div>\r\n                <div class=\"canvas-settings-row\">\r\n                  <span class=\"canvas-settings-label\"><span data-i18n=\"snapNodes\">Snap nodes</span><small data-i18n=\"snapNodesHelp\">Drag AgentNodes by grid step</small></span>\r\n                  <input id=\"snapNodesInput\" type=\"checkbox\">\r\n                </div>\r\n                <button type=\"button\" class=\"button subtle canvas-settings-align\" id=\"alignNodesButton\" data-i18n=\"alignNodes\">Align existing nodes</button>\r\n              </div>\r\n              <div class=\"canvas-settings-section\">\r\n                <div class=\"canvas-settings-label\"><span data-i18n=\"connectionRouting\">Connection routing</span><small data-i18n=\"connectionRoutingHelp\">Free curves or rounded orthogonal grid routes</small></div>\r\n                <div class=\"canvas-settings-routing\" role=\"group\" aria-label=\"Connection routing\">\r\n                  <button type=\"button\" class=\"segment\" data-routing-mode=\"free\" data-i18n=\"routingFree\">Free</button>\r\n                  <button type=\"button\" class=\"segment\" data-routing-mode=\"orthogonal\" data-i18n=\"routingOrthogonal\">Grid</button>\r\n                </div>\r\n              </div>\r\n            </div>\r\n          </div>\r\n          <div class=\"canvas-toolbar-spacer\"></div>\r\n          <div class=\"legend\">\r\n            <span class=\"legend-item\"><span class=\"legend-line authority\"></span><span data-i18n=\"authority\">Authority</span></span>\r\n            <span class=\"legend-item\"><span class=\"legend-line communication\"></span><span data-i18n=\"communication\">Communication</span></span>\r\n          </div>\r\n        </div>\r\n\r\n        <div class=\"canvas-shell\" id=\"canvasShell\" tabindex=\"0\">\r\n          <div class=\"connection-banner\" id=\"connectionBanner\" hidden></div>\r\n          <div class=\"canvas-empty\" id=\"canvasEmpty\" hidden>\r\n            <div class=\"empty-icon\">◎</div>\r\n            <h2 data-i18n=\"emptyTitle\">Build an agent team</h2>\r\n            <p data-i18n=\"emptyBody\">Add AgentNodes, assign one Entry Agent, then connect authority and communication independently.</p>\r\n            <button type=\"button\" class=\"button primary\" id=\"emptyAddButton\" data-i18n=\"addFirstAgent\">Add first AgentNode</button>\r\n          </div>\r\n          <div class=\"canvas-stage\" id=\"canvasStage\">\r\n            <div class=\"canvas-world\" id=\"canvasWorld\">\r\n            <svg class=\"edge-layer\" id=\"edgeLayer\" xmlns=\"http://www.w3.org/2000/svg\" aria-label=\"Connections\">\r\n              <defs>\r\n                <marker id=\"arrowAuthority\" markerWidth=\"10\" markerHeight=\"10\" refX=\"9\" refY=\"3\" orient=\"auto\" markerUnits=\"strokeWidth\">\r\n                  <path d=\"M0,0 L0,6 L9,3 z\" class=\"marker-authority\"></path>\r\n                </marker>\r\n                <marker id=\"arrowCommunication\" markerWidth=\"10\" markerHeight=\"10\" refX=\"9\" refY=\"3\" orient=\"auto-start-reverse\" markerUnits=\"strokeWidth\">\r\n                  <path d=\"M0,0 L0,6 L9,3 z\" class=\"marker-communication\"></path>\r\n                </marker>\r\n              </defs>\r\n              <g id=\"edgeGroup\"></g>\r\n              <path id=\"draftEdge\" class=\"edge draft\" d=\"\" hidden></path>\r\n            </svg>\r\n            <div class=\"node-layer\" id=\"nodeLayer\"></div>\r\n            </div>\r\n          </div>\r\n          <div class=\"canvas-hint\" id=\"canvasHint\" data-i18n=\"canvasHint\">Drag empty space to pan · wheel to zoom · Delete removes selection</div>\r\n        </div>\r\n      </section>\r\n\r\n      <aside class=\"inspector\" id=\"inspector\">\r\n        <div class=\"inspector-header\">\r\n          <div>\r\n            <div class=\"eyebrow\" data-i18n=\"inspector\">Inspector</div>\r\n            <h2 id=\"inspectorTitle\" data-i18n=\"nothingSelected\">Nothing selected</h2>\r\n          </div>\r\n          <div class=\"inspector-header-actions\">\r\n            <button type=\"button\" class=\"icon-button inspector-collapse-button\" id=\"inspectorCollapseButton\" aria-expanded=\"true\">‹</button>\r\n            <button type=\"button\" class=\"icon-button danger-ghost\" id=\"deleteSelectionButton\" title=\"Delete\" hidden>×</button>\r\n          </div>\r\n        </div>\r\n\r\n        <div class=\"inspector-empty\" id=\"inspectorEmpty\">\r\n          <div class=\"empty-ring\">◇</div>\r\n          <p data-i18n=\"inspectorEmpty\">Select an AgentNode or connection to edit it.</p>\r\n        </div>\r\n\r\n        <form class=\"inspector-form\" id=\"nodeInspector\" hidden>\r\n          <div class=\"section-heading\">\r\n            <span data-i18n=\"identity\">Identity</span>\r\n          </div>\r\n\r\n          <label class=\"field\">\r\n            <span data-i18n=\"displayName\">Display name</span>\r\n            <input id=\"displayNameInput\" type=\"text\" maxlength=\"64\">\r\n          </label>\r\n\r\n          <details class=\"agent-details\" id=\"agentDetailsDisclosure\">\r\n            <summary>\r\n              <span class=\"agent-details-summary-copy\">\r\n                <strong data-i18n=\"advancedDetails\">Technical details</strong>\r\n                <small data-i18n=\"advancedDetailsHint\">Technical name, role and system prompt</small>\r\n              </span>\r\n              <span class=\"agent-details-chevron\" aria-hidden=\"true\">›</span>\r\n            </summary>\r\n            <div class=\"agent-details-content\">\r\n              <span class=\"node-id\" id=\"nodeIdLabel\"></span>\r\n              <label class=\"field\">\r\n                <span data-i18n=\"technicalName\">Technical name</span>\r\n                <input id=\"technicalNameInput\" type=\"text\" maxlength=\"48\" spellcheck=\"false\">\r\n              </label>\r\n              <label class=\"field\">\r\n                <span data-i18n=\"role\">Role</span>\r\n                <input id=\"roleInput\" type=\"text\" maxlength=\"120\">\r\n              </label>\r\n              <label class=\"field\">\r\n                <span data-i18n=\"systemPrompt\">System prompt</span>\r\n                <textarea id=\"systemPromptInput\" rows=\"5\"></textarea>\r\n              </label>\r\n            </div>\r\n          </details>\r\n\r\n          <div class=\"section-heading\"><span data-i18n=\"modelSection\">Model</span></div>\r\n          <div class=\"field-grid two\">\r\n            <label class=\"field\">\r\n              <span data-i18n=\"provider\">Provider</span>\r\n              <select id=\"providerSelect\"></select>\r\n            </label>\r\n            <label class=\"field\">\r\n              <span data-i18n=\"model\">Model</span>\r\n              <select id=\"modelSelect\"></select>\r\n            </label>\r\n          </div>\r\n          <label class=\"field\">\r\n            <span data-i18n=\"reasoningEffort\">Reasoning effort</span>\r\n            <select id=\"reasoningSelect\"></select>\r\n            <small class=\"field-help\" data-i18n=\"reasoningHelp\">Values come from the selected provider/model.</small>\r\n          </label>\r\n\r\n          <div class=\"section-heading split-heading\">\r\n            <span data-i18n=\"capabilities\">Capabilities</span>\r\n            <span class=\"policy-note\" data-i18n=\"denyWins\">deny wins</span>\r\n          </div>\r\n          <div class=\"capability-tabs\" id=\"capabilityTabs\">\r\n            <span data-i18n=\"tools\">Tools</span> · <span data-i18n=\"skillsPreview\">Session skill loader</span>\r\n          </div>\r\n          <div class=\"capability-list\" id=\"capabilityList\"></div>\r\n\r\n          <div class=\"section-heading\"><span data-i18n=\"teamRole\">Team role</span></div>\r\n          <div class=\"entry-control\" id=\"entryControl\">\r\n            <div>\r\n              <strong data-i18n=\"entryAgent\">Entry Agent</strong>\r\n              <small id=\"entryAgentHelp\" data-i18n=\"entryHelp\">Exactly one node receives the primary user channel.</small>\r\n            </div>\r\n            <div class=\"entry-status-row\">\r\n              <span class=\"entry-status\" id=\"entryAgentStatus\"></span>\r\n              <button type=\"button\" class=\"button\" id=\"makeEntryButton\" data-i18n=\"makeEntry\">Make Entry Agent</button>\r\n            </div>\r\n          </div>\r\n\r\n          <div class=\"section-heading\"><span data-i18n=\"runtime\">Runtime</span></div>\r\n          <div class=\"runtime-card\">\r\n            <div>\r\n              <span class=\"status-dot\" id=\"inspectorStatusDot\"></span>\r\n              <span id=\"inspectorRuntimeStatus\">NOT_STARTED</span>\r\n            </div>\r\n            <button type=\"button\" class=\"button full\" id=\"openChatButton\" disabled data-i18n=\"openChat\">Open Chat</button>\r\n            <small id=\"openChatHelp\" data-i18n=\"openChatHelp\">Available with real DSH Session bindings in a production runtime milestone.</small>\r\n          </div>\r\n        </form>\r\n\r\n        <div class=\"edge-inspector\" id=\"edgeInspector\" hidden>\r\n          <div class=\"edge-kind-badge\" id=\"edgeKindBadge\"></div>\r\n          <div class=\"edge-summary\" id=\"edgeSummary\"></div>\r\n          <div class=\"edge-direction-note\" id=\"edgeDirectionNote\" hidden></div>\r\n          <p class=\"muted\" id=\"edgeDescription\"></p>\r\n          <button type=\"button\" class=\"button danger full\" id=\"deleteEdgeButton\" data-i18n=\"deleteConnection\">Delete connection</button>\r\n        </div>\r\n      </aside>\r\n    </main>\r\n\r\n    <section class=\"status-dock collapsed\" id=\"statusDock\">\r\n      <div class=\"status-dock-header\">\r\n        <div class=\"status-summary\">\r\n          <span class=\"run-pill\" id=\"runPill\" data-state=\"STOPPED\"><span class=\"pulse\"></span><span id=\"runStateLabel\">STOPPED</span></span>\r\n          <span class=\"validation-summary\" id=\"validationSummary\" data-i18n=\"notValidated\">Not validated</span>\r\n          <span class=\"compact-metrics\" aria-label=\"Team metrics\">\r\n            <span><strong id=\"compactMetricAgents\">0</strong> <span data-i18n=\"agents\">Agents</span></span>\r\n            <span><strong id=\"compactMetricAuthority\">0</strong> Authority</span>\r\n            <span><strong id=\"compactMetricCommunication\">0</strong> Communication</span>\r\n          </span>\r\n        </div>\r\n        <button type=\"button\" class=\"dock-toggle\" id=\"dockToggle\" aria-expanded=\"false\"><span data-i18n=\"validationRuntime\">Validation / runtime</span><span class=\"chevron\">⌃</span></button>\r\n      </div>\r\n      <div class=\"status-dock-body\" id=\"statusDockBody\">\r\n        <div class=\"validation-panel\">\r\n          <div class=\"panel-title-row\">\r\n            <h3 data-i18n=\"validation\">Validation</h3>\r\n            <span class=\"badge neutral\" id=\"validationBadge\">—</span>\r\n          </div>\r\n          <div class=\"validation-list\" id=\"validationList\"></div>\r\n        </div>\r\n        <div class=\"runtime-panel\">\r\n          <div class=\"panel-title-row\">\r\n            <h3 data-i18n=\"mockRuntime\">Mock TeamRun</h3>\r\n            <span class=\"muted\" id=\"runIdLabel\">—</span>\r\n          </div>\r\n          <div class=\"runtime-copy\" id=\"runtimeCopy\" data-i18n=\"runtimeStoppedHelp\">Select a native Postman Chat to run this team.</div>\r\n          <div class=\"nodes-activity\" id=\"nodesActivity\" role=\"status\" aria-live=\"polite\"></div>\r\n          <div class=\"runtime-metrics\">\r\n            <div><span data-i18n=\"agents\">Agents</span><strong id=\"metricAgents\">0</strong></div>\r\n            <div><span data-i18n=\"authority\">Authority</span><strong id=\"metricAuthority\">0</strong></div>\r\n            <div><span data-i18n=\"communication\">Communication</span><strong id=\"metricCommunication\">0</strong></div>\r\n          </div>\r\n        </div>\r\n      </div>\r\n    </section>\r\n  </div>\r\n\r\n  <div class=\"toast-stack\" id=\"toastStack\" aria-live=\"polite\"></div>\r\n  <div id=\"smokeResult\" hidden></div>\r\n";
 const EDITOR_CSS = ".nodes-agent-root {width:100%;height:100%;min-height:560px;overflow:hidden;}\r\n.nodes-agent-dialog {box-sizing:border-box;position:fixed;inset:0;width:100vw;max-width:none;height:100vh;max-height:none;padding:26px 0 0;margin:0;border:0;background:#0b0e14;overflow:hidden;}\r\n.nodes-agent-close {position:absolute;right:8px;top:0;background:none;border:0;color:#edf2f7;font-size:22px;cursor:pointer;}\r\n.nodes-team-choice-panel {position:absolute;right:0;bottom:40px;z-index:50;background:#151d29;color:#edf2f7;padding:12px;display:grid;gap:8px;border:1px solid #293446;border-radius:8px;}\r\n.nodes-team-choice {position:relative;}\r\n@scope (.nodes-agent-root) {\r\n\r\n:scope {\r\n  color-scheme: dark;\r\n  --bg: #0b0e14;\r\n  --panel: #111722;\r\n  --panel-2: #151d29;\r\n  --panel-3: #1a2432;\r\n  --line: #293446;\r\n  --line-soft: #202a39;\r\n  --text: #edf2f7;\r\n  --muted: #8fa0b6;\r\n  --muted-2: #68798f;\r\n  --accent: #7c9cff;\r\n  --accent-2: #9b8cff;\r\n  --accent-soft: rgba(124,156,255,.12);\r\n  --authority: #ffb454;\r\n  --communication: #58d5c9;\r\n  --danger: #ff6b7a;\r\n  --success: #64d98b;\r\n  --warning: #ffd166;\r\n  --shadow: 0 18px 60px rgba(0,0,0,.32);\r\n  --radius: 12px;\r\n  --topbar-h: 64px;\r\n  --dock-h: 210px;\r\n  --inspector-w: 360px;\r\n  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;\r\n}\r\n\r\n* { box-sizing: border-box; }\r\n:scope { width: 100%; height: 100%; overflow: hidden; background: var(--bg); color: var(--text); }\r\nbutton, input, textarea, select { font: inherit; }\r\nbutton { color: inherit; }\r\nbutton:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, .canvas-shell:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }\r\n[hidden] { display: none !important; }\r\n.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0,0,0,0); border: 0; }\r\n\r\n.app-shell { display: grid; grid-template-rows: var(--topbar-h) minmax(0,1fr) auto; height: 100%; background: linear-gradient(180deg,#0d1119,#090c12); }\r\n.topbar { display: flex; align-items: center; gap: 18px; min-width: 0; padding: 0 16px; border-bottom: 1px solid var(--line); background: rgba(14,19,28,.96); box-shadow: 0 2px 14px rgba(0,0,0,.2); z-index: 20; }\r\n.brand-block { display: flex; align-items: center; gap: 10px; min-width: 238px; }\r\n.brand-mark { width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid #405171; border-radius: 9px; background: linear-gradient(145deg,#283956,#151e2c); color: #c9d5ff; font-weight: 800; font-size: 12px; letter-spacing: .08em; }\r\n.brand-title { font-weight: 760; letter-spacing: -.02em; font-size: 14px; }\r\n.brand-subtitle { margin-top: 2px; color: var(--muted-2); font-size: 11px; }\r\n.team-block { display: flex; align-items: center; gap: 9px; min-width: 0; flex: 1; }\r\n.team-name { width: min(240px, 28vw); border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--text); padding: 7px 9px; font-weight: 650; }\r\n.team-name:hover { background: var(--panel-2); }\r\n.team-name:focus { border-color: var(--line); background: var(--panel-2); }\r\n.save-state { color: var(--muted-2); font-size: 11px; white-space: nowrap; }\r\n.toolbar-actions { display: flex; align-items: center; gap: 8px; white-space: nowrap; }\r\n.toolbar-cluster { display: inline-flex; align-items: center; gap: 5px; }\r\n.toolbar-cluster + .toolbar-cluster { padding-left: 8px; border-left: 1px solid var(--line-soft); }\r\n.toolbar-cluster.utility .button { color: #8fa0b6; }\r\n.button, .icon-button, .segment, .dock-toggle, .capability-tab { border: 1px solid var(--line); background: #171f2b; cursor: pointer; transition: .15s ease; }\r\n.validate-button { display: inline-flex; align-items: center; gap: 7px; }\r\n.validate-button-status { display: none; padding: 2px 5px; border-radius: 999px; font-size: 8px; font-weight: 850; letter-spacing: .04em; }\r\n.validate-button[data-validation=\"pass\"] .validate-button-status { display: inline-block; color: #9becb2; background: rgba(100,217,139,.12); }\r\n.validate-button[data-validation=\"failed\"] .validate-button-status { display: inline-block; color: #ff9ba6; background: rgba(255,107,122,.12); }\r\n.button { min-height: 34px; padding: 7px 12px; border-radius: 8px; font-weight: 650; font-size: 12px; }\r\n.button:hover, .icon-button:hover, .segment:hover:not(:disabled), .capability-tab:hover:not(:disabled) { border-color: #40506a; background: #202a39; }\r\n.button.primary { border-color: #607ee0; background: linear-gradient(180deg,#6887ee,#536fd0); color: #fff; }\r\n.button.primary:hover { filter: brightness(1.06); }\r\n.button.subtle { background: transparent; color: #b3c0d2; }\r\n.button.danger { border-color: rgba(255,107,122,.35); background: rgba(255,107,122,.09); color: #ff9ba6; }\r\n.button:disabled { opacity: .42; cursor: not-allowed; }\r\n.button.full { width: 100%; }\r\n.segmented { display: inline-flex; border-radius: 8px; background: #101620; padding: 2px; border: 1px solid var(--line-soft); }\r\n.segmented.compact .segment { min-width: 34px; padding: 5px 6px; }\r\n.segment { min-height: 28px; padding: 5px 9px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font-size: 11px; font-weight: 700; }\r\n.segment.is-active { background: #283449; color: var(--text); box-shadow: inset 0 0 0 1px #35435b; }\r\n\r\n.workspace { display: grid; grid-template-columns: minmax(0,1fr) var(--inspector-w); min-height: 0; transition: grid-template-columns .16s ease; }\r\n.workspace.inspector-collapsed { grid-template-columns: minmax(0,1fr) 42px; }\r\n.editor-pane { display: grid; grid-template-rows: 44px minmax(0,1fr); min-width: 0; min-height: 0; border-right: 1px solid var(--line); }\r\n.canvas-toolbar { position: relative; display: flex; align-items: center; gap: 6px; padding: 0 10px; border-bottom: 1px solid var(--line-soft); background: #101620; z-index: 9; }\r\n.icon-button { width: 30px; height: 30px; border-radius: 7px; display: inline-grid; place-items: center; padding: 0; font-weight: 760; }\r\n.icon-button.label-button { width: auto; grid-auto-flow: column; gap: 6px; padding: 0 9px; font-size: 11px; }\r\n.icon-button.danger-ghost { background: transparent; color: #d98a95; border-color: transparent; font-size: 19px; }\r\n.icon-button.danger-ghost:hover { border-color: rgba(255,107,122,.25); background: rgba(255,107,122,.08); }\r\n.toolbar-divider { width: 1px; height: 20px; margin: 0 3px; background: var(--line-soft); }\r\n.canvas-toolbar-spacer { flex: 1; }\r\n.zoom-readout { width: 45px; text-align: center; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }\r\n.legend { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 10px; }\r\n.legend-item { display: inline-flex; align-items: center; gap: 5px; }\r\n.legend-line { width: 22px; height: 0; border-top: 2px solid; position: relative; }\r\n.legend-line.authority { border-color: var(--authority); }\r\n.legend-line.communication { border-color: var(--communication); border-top-style: dashed; }\r\n.canvas-settings-wrap { position: relative; }\r\n.canvas-settings-button.is-active { border-color: #4c5f7e; background: #222d3f; color: #d7e1ee; }\r\n.canvas-settings-popover { position: absolute; right: 0; top: 36px; z-index: 40; width: 286px; padding: 11px; border: 1px solid #334158; border-radius: 10px; background: rgba(15,21,31,.98); box-shadow: 0 18px 50px rgba(0,0,0,.42); backdrop-filter: blur(12px); }\r\n.canvas-settings-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 9px; color: #c7d3e3; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }\r\n.canvas-settings-section { padding: 9px 0; border-top: 1px solid var(--line-soft); }\r\n.canvas-settings-section:first-of-type { border-top: 0; padding-top: 0; }\r\n.canvas-settings-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 30px; color: #aab8ca; font-size: 10px; }\r\n.canvas-settings-row + .canvas-settings-row { margin-top: 4px; }\r\n.canvas-settings-row select { width: 106px; border: 1px solid #2d394d; border-radius: 6px; background: #0d131d; color: var(--text); padding: 6px 7px; font-size: 10px; }\r\n.canvas-settings-row input[type=\"checkbox\"] { accent-color: var(--accent); }\r\n.canvas-settings-label { display: grid; gap: 2px; }\r\n.canvas-settings-label small { color: #607188; font-size: 8.5px; font-weight: 500; line-height: 1.35; }\r\n.canvas-settings-routing { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-top: 7px; }\r\n.canvas-settings-routing .segment { border: 1px solid #2b384c; min-height: 31px; }\r\n.canvas-settings-align { width: 100%; margin-top: 8px; }\r\n\r\n.canvas-shell { position: relative; overflow: hidden; min-height: 0; cursor: default; background-color: #0b1018; background-image: radial-gradient(circle at 1px 1px, rgba(114,133,164,.25) 1px, transparent 1.1px); background-size: 22px 22px; }\r\n.canvas-shell.is-panning { cursor: grabbing; }\r\n.canvas-shell.edge-authority { cursor: crosshair; }\r\n.canvas-shell.edge-communication { cursor: crosshair; }\r\n.canvas-stage { position: absolute; width: 4000px; height: 3000px; transform-origin: 0 0; }\r\n.canvas-world { position: absolute; inset: 0; width: 4000px; height: 3000px; transform-origin: 0 0; text-rendering: geometricPrecision; }\r\n.edge-layer { position: absolute; inset: 0; width: 4000px; height: 3000px; overflow: visible; pointer-events: none; }\r\n.edge-group { pointer-events: none; }\r\n.node-layer { position: absolute; inset: 0; }\r\n.edge-hit { fill: none; stroke: transparent; stroke-width: 14px; pointer-events: stroke; cursor: pointer; }\r\n.edge { fill: none; stroke-width: 2.1px; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; transition: opacity .14s ease, stroke-width .14s ease; }\r\n.edge.authority { stroke: var(--authority); marker-end: url(#arrowAuthority); opacity: .96; }\r\n.edge.communication { stroke: var(--communication); stroke-dasharray: 7 6; marker-end: url(#arrowCommunication); opacity: .78; }\r\n.edge.communication.bidirectional { marker-start: url(#arrowCommunication); }\r\n.communication-direction-control { display: inline-flex; }\r\n.communication-direction-control .segment { min-width: 31px; padding-inline: 8px; font-size: 12px; }\r\n.communication-direction-control .segment span[data-i18n] { margin-left: 4px; font-size: 9px; }\r\n@media (max-width: 1180px) { .communication-direction-control .segment span[data-i18n] { display: none; } }\r\n.edge-group-item.is-dimmed .edge { opacity: .22; }\r\n.edge-group-item.is-dimmed .edge-hit { pointer-events: stroke; }\r\n.edge.selected { opacity: 1; stroke-width: 3.4px; filter: drop-shadow(0 0 5px currentColor); }\r\n.edge.draft { stroke: #b5c6e6; stroke-dasharray: 4 5; stroke-width: 1.5px; opacity: .7; }\r\n.marker-authority { fill: var(--authority); }\r\n.marker-communication { fill: var(--communication); }\r\n.edge-label-bg { fill: rgba(10,14,21,.95); stroke-width: 1px; }\r\n.edge-label-bg.authority { stroke: rgba(255,180,84,.45); }\r\n.edge-label-bg.communication { stroke: rgba(88,213,201,.45); }\r\n.edge-label { fill: #aebcd0; font-size: 9px; text-anchor: middle; dominant-baseline: central; pointer-events: none; letter-spacing: .04em; text-transform: uppercase; }\r\n\r\n.agent-node { position: absolute; width: 216px; min-height: 126px; user-select: none; border: 1px solid #334056; border-radius: 12px; background: linear-gradient(180deg,rgba(28,38,52,.98),rgba(17,24,34,.98)); box-shadow: 0 12px 25px rgba(0,0,0,.25); overflow: hidden; transform-origin: 0 0; transition: border-color .12s ease, box-shadow .12s ease; }\r\n.agent-node:hover { border-color: #465773; }\r\n.agent-node.selected { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(124,156,255,.25), 0 15px 32px rgba(0,0,0,.3); }\r\n.agent-node.edge-peer { border-color: #526784; }\r\n.agent-node.edge-source-authority { border-color: var(--authority); box-shadow: 0 0 0 1px rgba(255,180,84,.2), 0 15px 32px rgba(0,0,0,.3); }\r\n.agent-node.edge-source-communication { border-color: var(--communication); box-shadow: 0 0 0 1px rgba(88,213,201,.18), 0 15px 32px rgba(0,0,0,.3); }\r\n.agent-node.edge-target-candidate { border-color: #45566f; }\r\n.agent-node.edge-target-candidate:hover { border-color: var(--accent); }\r\n.agent-node.entry { box-shadow: inset 0 2px 0 rgba(155,140,255,.8), 0 12px 25px rgba(0,0,0,.25); }\r\n.agent-node.dragging { box-shadow: 0 20px 42px rgba(0,0,0,.42); }\r\n.node-runtime-strip { height: 4px; background: #42506a; }\r\n.agent-node[data-runtime=\"RUNNING\"] .node-runtime-strip { background: var(--success); box-shadow: 0 0 12px rgba(100,217,139,.5); }\r\n.agent-node[data-runtime=\"IDLE\"] .node-runtime-strip { background: #5fb7ff; }\r\n.agent-node[data-runtime=\"PAUSED\"] .node-runtime-strip { background: var(--warning); }\r\n.agent-node[data-runtime=\"ERROR\"] .node-runtime-strip { background: var(--danger); }\r\n.agent-node[data-runtime=\"STOPPED\"] .node-runtime-strip { background: #657184; }\r\n.node-body { padding: 12px 13px 11px; }\r\n.node-topline { display: flex; align-items: flex-start; gap: 7px; }\r\n.node-title-wrap { min-width: 0; flex: 1; }\r\n.node-title { font-size: 13px; font-weight: 780; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\r\n.node-role { margin-top: 3px; color: var(--muted); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\r\n.entry-badge { flex: none; padding: 3px 5px; border-radius: 5px; background: rgba(155,140,255,.13); color: #c4b9ff; border: 1px solid rgba(155,140,255,.28); font-size: 9px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }\r\n.node-meta { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; margin-top: 13px; padding-top: 9px; border-top: 1px solid rgba(64,78,99,.4); }\r\n.model-chip { min-width: 0; color: #c2ccda; font-size: 10px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }\r\n.runtime-chip { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 9.5px; font-weight: 700; }\r\n.runtime-dot { width: 7px; height: 7px; border-radius: 50%; background: #657184; }\r\n.agent-node[data-runtime=\"RUNNING\"] .runtime-dot { background: var(--success); box-shadow: 0 0 0 3px rgba(100,217,139,.12); }\r\n.agent-node[data-runtime=\"IDLE\"] .runtime-dot { background: #5fb7ff; }\r\n.agent-node[data-runtime=\"PAUSED\"] .runtime-dot { background: var(--warning); }\r\n.agent-node[data-runtime=\"ERROR\"] .runtime-dot { background: var(--danger); }\r\n.node-port { position: absolute; width: 11px; height: 11px; border-radius: 50%; border: 2px solid #111923; opacity: .68; transition: opacity .12s ease, transform .12s ease, box-shadow .12s ease; pointer-events: none; z-index: 3; box-shadow: 0 0 0 1px rgba(255,255,255,.04); }\r\n.node-port.authority { background: var(--authority); }\r\n.node-port.communication { background: var(--communication); }\r\n.node-port.authority.in { left: 50%; top: -6px; transform: translateX(-50%); }\r\n.node-port.authority.out { left: 50%; bottom: -6px; transform: translateX(-50%); }\r\n.node-port.communication.in { left: -6px; top: 50%; transform: translateY(-50%); }\r\n.node-port.communication.out { right: -6px; top: 50%; transform: translateY(-50%); }\r\n.canvas-shell.edge-authority .node-port.authority { opacity: 1; box-shadow: 0 0 0 3px rgba(255,180,84,.10); }\r\n.canvas-shell.edge-authority .node-port.communication { opacity: .22; }\r\n.canvas-shell.edge-communication .node-port.communication { opacity: 1; box-shadow: 0 0 0 3px rgba(88,213,201,.10); }\r\n.canvas-shell.edge-communication .node-port.authority { opacity: .22; }\r\n.agent-node:hover .node-port { opacity: 1; }\r\n\r\n.canvas-empty { position: absolute; inset: 0; z-index: 3; display: grid; place-content: center; justify-items: center; text-align: center; padding: 30px; pointer-events: none; }\r\n.canvas-empty .button { pointer-events: auto; }\r\n.empty-icon, .empty-ring { display: grid; place-items: center; width: 54px; height: 54px; border-radius: 50%; border: 1px solid #344158; background: #131b27; color: #8295b2; font-size: 26px; }\r\n.canvas-empty h2 { margin: 14px 0 5px; font-size: 18px; }\r\n.canvas-empty p { max-width: 460px; margin: 0 0 16px; color: var(--muted); font-size: 12px; line-height: 1.6; }\r\n.canvas-hint { position: absolute; left: 12px; bottom: 10px; z-index: 5; padding: 6px 8px; border-radius: 6px; color: #71839a; background: rgba(12,17,25,.75); border: 1px solid rgba(52,65,88,.45); font-size: 10px; pointer-events: none; }\r\n.connection-banner { position: absolute; left: 50%; top: 12px; z-index: 8; transform: translateX(-50%); max-width: min(620px,calc(100% - 40px)); padding: 8px 11px; border: 1px solid #3a4a62; border-radius: 8px; background: rgba(14,20,30,.94); box-shadow: 0 10px 28px rgba(0,0,0,.28); color: #c8d3e2; font-size: 10.5px; font-weight: 650; pointer-events: none; }\r\n.connection-banner.authority { border-color: rgba(255,180,84,.42); color: #ffd296; }\r\n.connection-banner.communication { border-color: rgba(88,213,201,.38); color: #9af0e8; }\r\n\r\n.inspector { min-width: 0; min-height: 0; overflow: auto; background: #101620; }\r\n.inspector-header { position: sticky; top: 0; z-index: 4; min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; background: rgba(16,22,32,.95); border-bottom: 1px solid var(--line-soft); backdrop-filter: blur(10px); }\r\n.inspector-header-actions { display: inline-flex; align-items: center; gap: 4px; }\r\n.inspector-collapse-button { width: 28px; height: 28px; font-size: 17px; color: #8fa0b6; background: transparent; border-color: transparent; }\r\n.workspace.inspector-collapsed .inspector { overflow: hidden; }\r\n.workspace.inspector-collapsed .inspector-header { height: 100%; min-height: 0; align-items: flex-start; justify-content: center; padding: 10px 6px; border-bottom: 0; }\r\n.workspace.inspector-collapsed .inspector-header > div:first-child,\r\n.workspace.inspector-collapsed .inspector-empty,\r\n.workspace.inspector-collapsed .inspector-form,\r\n.workspace.inspector-collapsed .edge-inspector,\r\n.workspace.inspector-collapsed #deleteSelectionButton { display: none !important; }\r\n.workspace.inspector-collapsed .inspector-header-actions { display: block; }\r\n.eyebrow { color: var(--muted-2); font-size: 9px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }\r\n.inspector-header h2 { margin: 3px 0 0; font-size: 14px; letter-spacing: -.01em; }\r\n.inspector-empty { display: grid; justify-items: center; padding: 70px 30px; text-align: center; color: var(--muted); }\r\n.inspector-empty p { max-width: 230px; font-size: 11px; line-height: 1.6; }\r\n.inspector-form, .edge-inspector { padding: 14px 14px 28px; }\r\n.section-heading { display: flex; align-items: center; gap: 8px; margin: 16px 0 9px; color: #b8c5d7; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }\r\n.section-heading:first-child { margin-top: 0; }\r\n.agent-details { margin: 4px 0 14px; border: 1px solid #273348; border-radius: 8px; background: #0d141f; overflow: hidden; }\r\n.agent-details summary { list-style: none; display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 8px 10px; cursor: pointer; color: #9eacc0; font-size: 10px; font-weight: 750; user-select: none; }\r\n.agent-details summary::-webkit-details-marker { display: none; }\r\n.agent-details summary:hover { background: #111a27; color: #c2cddd; }\r\n.agent-details-summary-copy { min-width: 0; flex: 1; }\r\n.agent-details-summary-copy strong { display: block; color: inherit; font-size: 10px; }\r\n.agent-details-summary-copy small { display: block; margin-top: 2px; color: #65758b; font-size: 9px; font-weight: 500; line-height: 1.35; }\r\n.agent-details-chevron { width: 16px; height: 16px; display: grid; place-items: center; flex: none; color: #71839a; font-size: 15px; transition: transform .14s ease; }\r\n.agent-details[open] .agent-details-chevron { transform: rotate(90deg); }\r\n.agent-details-content { padding: 10px 10px 0; border-top: 1px solid #253145; background: rgba(10,15,23,.32); }\r\n.agent-details .node-id { display: block; margin: 0 0 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\r\n.split-heading { justify-content: space-between; }\r\n.node-id { margin-left: auto; color: #596c86; font-size: 9px; text-transform: none; letter-spacing: normal; font-family: ui-monospace,SFMono-Regular,Menlo,monospace; }\r\n.policy-note { padding: 2px 5px; border: 1px solid rgba(255,107,122,.22); border-radius: 5px; color: #d5848e; font-size: 9px; letter-spacing: .04em; text-transform: lowercase; }\r\n.field { display: grid; gap: 5px; margin-bottom: 10px; color: var(--muted); font-size: 10px; font-weight: 650; }\r\n.field input, .field textarea, .field select { width: 100%; border: 1px solid #2d394d; border-radius: 7px; background: #0d131d; color: var(--text); padding: 8px 9px; font-size: 11px; font-weight: 500; }\r\n.field textarea { min-height: 88px; resize: vertical; line-height: 1.45; }\r\n.field select { min-height: 34px; }\r\n.field-grid.two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }\r\n.field-help { color: #65758b; font-size: 10px; font-weight: 500; line-height: 1.4; }\r\n.capability-tabs { display: grid; grid-template-columns: repeat(3,1fr); gap: 5px; margin-bottom: 8px; }\r\n.capability-tab { min-height: 28px; border-radius: 6px; color: var(--muted); font-size: 9.5px; font-weight: 700; }\r\n.capability-tab.is-active { border-color: #435170; background: #222d3f; color: var(--text); }\r\n.capability-tab:disabled { opacity: .42; cursor: not-allowed; }\r\n.capability-list { display: grid; gap: 5px; }\r\n.cap-row { display: grid; grid-template-columns: minmax(0,1fr) 68px; gap: 7px; align-items: center; padding: 7px 8px; border: 1px solid #263246; border-radius: 7px; background: #0e141e; }\r\n.cap-name { min-width: 0; display: flex; align-items: center; gap: 7px; }\r\n.cap-name code { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: #c7d2e1; font-size: 10px; }\r\n.cap-kind { flex: none; padding: 2px 4px; border-radius: 4px; background: #202b3c; color: #7f92ad; font-size: 8.5px; text-transform: uppercase; }\r\n.cap-row select { width: 100%; border: 1px solid #2e3a4d; border-radius: 5px; background: #151d29; color: #c1ccda; padding: 4px; font-size: 10px; }\r\n.cap-row select[data-mode=\"deny\"] { border-color: rgba(255,107,122,.35); color: #ff9ba6; }\r\n.entry-control { display: grid; gap: 9px; padding: 10px; border: 1px solid #29354a; border-radius: 8px; background: #0d141f; }\r\n.entry-control.current { border-color: rgba(155,140,255,.35); background: rgba(155,140,255,.055); }\r\n.entry-control strong { display: block; font-size: 11px; }\r\n.entry-control small { display: block; margin-top: 3px; color: var(--muted); font-size: 10px; line-height: 1.45; }\r\n.entry-status-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }\r\n.entry-status { color: #c7d2e1; font-size: 10px; font-weight: 700; }\r\n.entry-status.current { color: #c4b9ff; }\r\n.runtime-card { display: grid; gap: 9px; padding: 10px; border: 1px solid #29354a; border-radius: 8px; background: #0d141f; }\r\n.runtime-card > div { display: flex; align-items: center; gap: 7px; color: #bcc7d6; font-size: 10px; font-weight: 700; }\r\n.status-dot { width: 8px; height: 8px; border-radius: 50%; background: #657184; }\r\n.runtime-card small { color: var(--muted-2); font-size: 10px; line-height: 1.45; }\r\n.edge-inspector { display: grid; gap: 12px; }\r\n.edge-kind-badge { width: fit-content; padding: 4px 7px; border-radius: 6px; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }\r\n.edge-kind-badge.authority { background: rgba(255,180,84,.11); color: #ffc676; border: 1px solid rgba(255,180,84,.25); }\r\n.edge-kind-badge.communication { background: rgba(88,213,201,.1); color: #83e9e0; border: 1px solid rgba(88,213,201,.22); }\r\n.edge-summary { font-size: 13px; line-height: 1.5; }\r\n.edge-direction-note { display: flex; align-items: center; gap: 7px; width: fit-content; padding: 5px 7px; border: 1px solid #2a394e; border-radius: 7px; background: #101824; color: #9fb0c6; font-size: 10px; font-weight: 700; }\r\n.edge-direction-note.bidirectional { border-color: rgba(88,213,201,.28); color: #9ae7df; }\r\n.muted { color: var(--muted); }\r\n\r\n.status-dock { border-top: 1px solid var(--line); background: #0e141d; z-index: 15; }\r\n.status-dock-header { height: 38px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 12px; border-bottom: 1px solid var(--line-soft); }\r\n.status-summary { display: flex; align-items: center; gap: 9px; min-width: 0; }\r\n.compact-metrics { display: inline-flex; align-items: center; gap: 8px; padding-left: 4px; color: #74869e; font-size: 9.5px; white-space: nowrap; }\r\n.compact-metrics span + span::before { content: '·'; margin-right: 8px; color: #42516a; }\r\n.compact-metrics strong { color: #aebed1; font-weight: 800; }\r\n.run-pill { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 7px; border: 1px solid #30405a; border-radius: 999px; color: #a7b5c9; background: #141c28; font-size: 9px; font-weight: 800; letter-spacing: .04em; }\r\n.run-pill .pulse { width: 6px; height: 6px; border-radius: 50%; background: #617087; }\r\n.run-pill[data-state=\"RUNNING\"] { border-color: rgba(100,217,139,.35); color: #97efb1; }\r\n.run-pill[data-state=\"RUNNING\"] .pulse { background: var(--success); box-shadow: 0 0 0 4px rgba(100,217,139,.1); }\r\n.run-pill[data-state=\"STARTING\"] .pulse { background: var(--warning); animation: pulse 1s infinite; }\r\n.run-pill[data-state=\"PAUSED\"] { color: #ffe099; border-color: rgba(255,209,102,.28); }\r\n.run-pill[data-state=\"PAUSED\"] .pulse { background: var(--warning); }\r\n.run-pill[data-state=\"FAILED\"] { color: #ff9ba6; border-color: rgba(255,107,122,.28); }\r\n.run-pill[data-state=\"FAILED\"] .pulse { background: var(--danger); }\r\n@keyframes pulse { 50% { opacity: .35; } }\r\n.validation-summary { color: var(--muted); font-size: 10px; }\r\n.dock-toggle { display: inline-flex; align-items: center; gap: 7px; border: 0; background: transparent; color: var(--muted); font-size: 9px; }\r\n.dock-toggle .chevron { transition: transform .15s; }\r\n.status-dock.collapsed .dock-toggle .chevron { transform: rotate(180deg); }\r\n.status-dock-body { height: 166px; display: grid; grid-template-columns: minmax(0,1.5fr) minmax(300px,.8fr); }\r\n.status-dock.collapsed .status-dock-body { display: none; }\r\n.validation-panel, .runtime-panel { min-width: 0; overflow: auto; padding: 10px 12px; }\r\n.runtime-panel { border-left: 1px solid var(--line-soft); }\r\n.panel-title-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }\r\n.panel-title-row h3 { margin: 0; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #a9b7ca; }\r\n.badge { padding: 2px 6px; border-radius: 999px; font-size: 9px; font-weight: 800; }\r\n.badge.neutral { background: #1a2432; color: var(--muted); }\r\n.badge.success { background: rgba(100,217,139,.1); color: #8ce9a8; }\r\n.badge.error { background: rgba(255,107,122,.1); color: #ff94a0; }\r\n.validation-list { display: grid; gap: 5px; }\r\n.validation-item { display: grid; grid-template-columns: 8px minmax(0,1fr) auto; gap: 7px; align-items: start; padding: 6px 7px; border-radius: 6px; background: #111924; color: #b8c4d4; font-size: 9.5px; cursor: default; }\r\n.validation-item:hover { background: #151f2c; }\r\n.validation-icon { width: 7px; height: 7px; margin-top: 3px; border-radius: 50%; background: var(--danger); }\r\n.validation-target { color: #687b93; font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 9px; }\r\n.validation-ok { padding: 16px 8px; color: #8fdda6; font-size: 10px; }\r\n.validation-empty { padding: 16px 8px; color: var(--muted); font-size: 10px; }\r\n.runtime-copy { color: var(--muted); font-size: 9.5px; line-height: 1.5; }\r\n.runtime-metrics { display: grid; grid-template-columns: repeat(3,1fr); gap: 7px; margin-top: 12px; }\r\n.runtime-metrics div { padding: 7px; border: 1px solid #273348; border-radius: 7px; background: #111925; }\r\n.runtime-metrics span { display: block; color: var(--muted-2); font-size: 8px; }\r\n.runtime-metrics strong { display: block; margin-top: 3px; font-size: 14px; }\r\n\r\n.toast-stack { position: fixed; right: 14px; bottom: 50px; z-index: 100; display: grid; gap: 7px; width: min(330px,calc(100vw - 28px)); pointer-events: none; }\r\n.toast { padding: 10px 11px; border: 1px solid #34425a; border-radius: 8px; background: rgba(21,29,41,.96); box-shadow: var(--shadow); color: #c8d2df; font-size: 10px; animation: toastIn .18s ease; }\r\n.toast.error { border-color: rgba(255,107,122,.35); }\r\n.toast.success { border-color: rgba(100,217,139,.35); }\r\n@keyframes toastIn { from { transform: translateY(7px); opacity: 0; } }\r\n\r\n@media (max-width: 1180px) {\r\n  :root { --inspector-w: 320px; }\r\n  .brand-subtitle, .save-state, .button.subtle#resetButton, .legend { display: none; }\r\n  .toolbar-actions { gap: 5px; }\r\n  .button { padding-inline: 9px; }\r\n}\r\n@media (max-width: 900px) {\r\n  :root { --inspector-w: 290px; }\r\n  .brand-block { min-width: 180px; }\r\n  .brand-mark { display: none; }\r\n  .team-name { width: 150px; }\r\n  .toolbar-actions .button.subtle { display: none; }\r\n  .field-grid.two { grid-template-columns: 1fr; }\r\n}\r\n\r\n\r\n\r\n.nodes-team-picker {max-width:150px;min-width:90px;background:#151d29;color:#edf2f7;border:1px solid #293446;border-radius:7px;height:31px;font-size:11px;}\r\n.nodes-activity {max-height:120px;overflow-y:auto;font-size:11px;color:var(--muted);padding:4px 10px;}\r\n.nodes-activity div {padding:3px 0;}\r\n}\r\n";
function mountEditor(root, bridge) {

  'use strict';
  const document = root.ownerDocument;
  const window = document.defaultView;
  const localStorage = window.localStorage;
  const requestAnimationFrame = window.requestAnimationFrame.bind(window);
  const setInterval = window.setInterval.bind(window);
  const clearInterval = window.clearInterval.bind(window);
  const setTimeout = window.setTimeout.bind(window);

  const STORAGE_KEYS = Object.freeze({
    definition: 'nodesAgentByAndrew.p0.teamDefinition.v1',
    layout: 'nodesAgentByAndrew.p0.teamLayout.v1',
    locale: 'nodesAgentByAndrew.p0.locale.v1',
    smokePhase: 'nodesAgentByAndrew.p0.smokePhase.v1'
  });

  const NODE_WIDTH = 216;
  const NODE_HEIGHT = 126;
  const STAGE_WIDTH = 4000;
  const STAGE_HEIGHT = 3000;
  const MIN_ZOOM = 0.35;
  const MAX_ZOOM = 1.8;

  // These catalogs are supplied by the active DSH Host, not the standalone P0 mocks.
  let MODEL_CATALOG = {};
  let CAPABILITY_CATALOG = [];
  let NATIVE_SLOTS = [];

  const I18N = Object.freeze({
    'en-US': {
      prototypeLabel: 'Phase P0 · UX Prototype', teamName: 'Team name', localDraft: 'Local draft', saved: 'Saved locally',
      loadDemo: 'Load demo', reset: 'Reset', save: 'Save', validate: 'Validate', start: 'Start', pause: 'Pause', resume: 'Resume', stop: 'Stop',
      addAgent: 'Agent', selectMode: 'Select', authority: 'Authority', communication: 'Communication', communicationBidirectional: 'Both', communicationOneWay: 'One-way', bidirectionalConnection: 'Bidirectional connection', oneWayConnection: 'One-way connection', fitView: 'Fit', canvasSettings: 'Canvas', canvasSettingsTitle: 'Canvas settings', showGrid: 'Show grid', showGridHelp: 'Visual coordinate grid', gridStyle: 'Grid style', gridDots: 'Dots', gridLines: 'Lines', gridSize: 'Grid step', snapNodes: 'Snap nodes', snapNodesHelp: 'Drag AgentNodes by grid step', alignNodes: 'Align existing nodes', connectionRouting: 'Connection routing', connectionRoutingHelp: 'Free curves or rounded orthogonal grid routes', routingFree: 'Free', routingOrthogonal: 'Grid',
      emptyTitle: 'Build an agent team', emptyBody: 'Add AgentNodes, assign one Entry Agent, then connect authority and communication independently.', addFirstAgent: 'Add first AgentNode',
      canvasHint: 'Drag empty space to pan · wheel to zoom · Delete removes selection', inspector: 'Inspector', nothingSelected: 'Nothing selected', inspectorEmpty: 'Select an AgentNode or connection to edit it.',
      identity: 'Identity', advancedDetails: 'Technical details', advancedDetailsHint: 'Technical name, role and system prompt', technicalName: 'Technical name', displayName: 'Display name', role: 'Role', systemPrompt: 'System prompt', modelSection: 'Model', provider: 'Provider', model: 'Model', reasoningEffort: 'Reasoning effort', reasoningHelp: 'Values come from the selected provider/model.',
      capabilities: 'Capabilities', denyWins: 'deny wins', tools: 'Tools', skillsPreview: 'Skills · preview', filesystemPreview: 'Filesystem · preview', repositoryPreview: 'Repository · preview', networkPreview: 'Network · preview',
      teamRole: 'Team role', entryAgent: 'Entry Agent', entryHelp: 'Exactly one node receives the primary user channel.', runtime: 'Runtime', openChat: 'Open Chat', openChatHelp: 'Available with real DSH Session bindings in a production runtime milestone.',
      deleteConnection: 'Delete connection', validationRuntime: 'Validation / runtime', notValidated: 'Not validated', validation: 'Validation', mockRuntime: 'TeamRun', runtimeStoppedHelp: 'Start a valid TeamDefinition to simulate TeamRun lifecycle.', agents: 'Agents',
      noValidationIssues: 'No blocking errors. TeamDefinition is ready to start.', validationPrompt: 'Run Validate to check the TeamDefinition.', validated: 'Validation passed', validationFailed: '{count} blocking error(s)',
      edgeAuthorityHelp: 'Organizational authority: manager → subordinate. It does not create Communication.', edgeCommunicationHelp: 'Allowed agent-to-agent direction. It does not change Authority.',
      sourceSelectedAuthority: 'Authority source selected. Choose a subordinate node.', sourceSelectedCommunication: 'First Communication agent selected. Choose the second agent.', edgeCreated: '{kind} connection created.', edgeExists: 'That connection already exists.', selfEdgeBlocked: 'Self-edge is not allowed.',
      savedToast: 'TeamDefinition and TeamLayout saved separately in browser storage.', resetToast: 'Prototype reset.', demoLoaded: 'Demo team loaded.', deleteNodeToast: 'AgentNode deleted.', deleteEdgeToast: 'Connection deleted.',
      startBlocked: 'Start blocked by validation errors.', starting: 'Starting mock TeamRun…', running: 'Mock TeamRun is running.', paused: 'Mock TeamRun paused.', resumed: 'Mock TeamRun resumed.', stopped: 'Mock TeamRun stopped. Editing is available again.',
      runtimeRunningHelp: 'Mock runtime only. AgentNode statuses simulate a future DSH-backed TeamRun.', runtimePausedHelp: 'Mock TeamRun is paused. Live schema editing remains outside P0/MVP.', runtimeStartingHelp: 'Valid TeamDefinition accepted. Simulating runtime bindings…',
      chatMock: 'Open Chat is a P0 mock. Production will navigate to the real DSH Session.', editLocked: 'Stop the mock TeamRun before editing TeamDefinition.',
      allow: 'Allow', deny: 'Deny', unset: 'Unset', entry: 'Entry', newAgent: 'Agent {n}', newRole: 'Team member',
      confirmReset: 'Reset the prototype and remove saved browser state?',
      errorMissingEntry: 'Entry Agent is missing.', errorEntryMissingNode: 'Entry Agent points to a missing AgentNode.', errorDuplicateName: 'Duplicate technical name: {name}.', errorRequiredField: '{field} is required.',
      errorInvalidModel: 'Model {provider}/{model} is not available in the mock catalog.', errorInvalidReasoning: 'Reasoning effort {value} is not supported by {provider}/{model}.', errorInvalidCapability: 'Capability reference {kind}:{id} is not in the mock catalog.',
      errorDanglingEdge: '{kind} connection has a missing endpoint.', errorAuthoritySelf: 'Authority self-edge is forbidden.', errorMultipleManagers: '{name} has more than one direct manager.', errorAuthorityCycle: 'Authority graph contains a cycle.',
      technicalNameLabel: 'Technical name', displayNameLabel: 'Display name', roleLabel: 'Role', systemPromptLabel: 'System prompt',
      inspectorDelete: 'Delete selection', addAgentTitle: 'Add AgentNode', zoomOutTitle: 'Zoom out', zoomInTitle: 'Zoom in', fitTitle: 'Fit view',
      collapseInspector: 'Collapse Inspector', expandInspector: 'Expand Inspector', makeEntry: 'Make Entry Agent', currentEntry: 'Current Entry Agent', entryAvailable: 'Not the current Entry Agent',
      entryCurrentHelp: 'This AgentNode receives the primary user channel. Assigning another node transfers Entry automatically.', entryOtherHelp: 'Assign this AgentNode as the single Entry Agent. The previous Entry will be cleared automatically.',
      connectionAuthorityPrompt: 'Authority · choose manager, then subordinate · Esc cancels', connectionAuthorityTarget: 'Authority · {name} → choose subordinate · Esc cancels',
      connectionCommunicationPrompt: 'Communication ↔ · choose first agent, then second · Esc cancels', connectionCommunicationTarget: 'Communication ↔ · {name} ↔ choose second agent · Esc cancels', connectionCommunicationPromptOneWay: 'Communication → · choose sender, then recipient · Esc cancels', connectionCommunicationTargetOneWay: 'Communication → · {name} → choose recipient · Esc cancels',
      definitionDraft: 'TeamDefinition draft', layoutDraft: 'TeamLayout draft', bothDraft: 'Definition + layout draft'
    },
    'ru-RU': {
      prototypeLabel: 'Phase P0 · UX-прототип', teamName: 'Название команды', localDraft: 'Локальный черновик', saved: 'Сохранено локально',
      loadDemo: 'Демо', reset: 'Сбросить', save: 'Сохранить', validate: 'Проверить', start: 'Запустить', pause: 'Пауза', resume: 'Продолжить', stop: 'Остановить',
      addAgent: 'Агент', selectMode: 'Выбор', authority: 'Authority', communication: 'Communication', communicationBidirectional: 'В обе стороны', communicationOneWay: 'В одну', bidirectionalConnection: 'Двусторонняя связь', oneWayConnection: 'Односторонняя связь', fitView: 'Вписать', canvasSettings: 'Холст', canvasSettingsTitle: 'Настройки холста', showGrid: 'Показывать сетку', showGridHelp: 'Визуальная координатная сетка', gridStyle: 'Вид сетки', gridDots: 'Точки', gridLines: 'Линии', gridSize: 'Шаг сетки', snapNodes: 'Привязка нодов', snapNodesHelp: 'Перемещение AgentNode по шагу сетки', alignNodes: 'Выровнять существующие ноды', connectionRouting: 'Маршрутизация связей', connectionRoutingHelp: 'Свободные кривые или скруглённые прямоугольные линии по сетке', routingFree: 'Свободные', routingOrthogonal: 'По сетке',
      emptyTitle: 'Соберите команду агентов', emptyBody: 'Добавьте AgentNode, назначьте один Entry Agent, затем независимо задайте Authority и Communication.', addFirstAgent: 'Добавить первый AgentNode',
      canvasHint: 'Тяните пустое место для панорамирования · колесо — масштаб · Delete удаляет выбранное', inspector: 'Инспектор', nothingSelected: 'Ничего не выбрано', inspectorEmpty: 'Выберите AgentNode или связь, чтобы настроить её.',
      identity: 'Идентификация', advancedDetails: 'Технические детали', advancedDetailsHint: 'Техническое имя, роль и системный промпт', technicalName: 'Техническое имя', displayName: 'Отображаемое имя', role: 'Роль', systemPrompt: 'Системный промпт', modelSection: 'Модель', provider: 'Провайдер', model: 'Модель', reasoningEffort: 'Усилие рассуждения', reasoningHelp: 'Доступные значения определяются выбранными провайдером и моделью.',
      capabilities: 'Возможности', denyWins: 'запрет приоритетнее', tools: 'Tools', skillsPreview: 'Skills · позже', filesystemPreview: 'Filesystem · позже', repositoryPreview: 'Repository · позже', networkPreview: 'Network · позже',
      teamRole: 'Роль в команде', entryAgent: 'Entry Agent', entryHelp: 'Ровно один узел получает основной пользовательский канал.', runtime: 'Runtime', openChat: 'Открыть чат', openChatHelp: 'Появится с реальной привязкой к DSH Session на production runtime milestone.',
      deleteConnection: 'Удалить связь', validationRuntime: 'Проверка / runtime', notValidated: 'Не проверено', validation: 'Проверка', mockRuntime: 'TeamRun', runtimeStoppedHelp: 'Запустите валидную TeamDefinition, чтобы имитировать lifecycle TeamRun.', agents: 'Агенты',
      noValidationIssues: 'Блокирующих ошибок нет. TeamDefinition готова к запуску.', validationPrompt: 'Нажмите «Проверить», чтобы проверить TeamDefinition.', validated: 'Проверка пройдена', validationFailed: 'Блокирующих ошибок: {count}',
      edgeAuthorityHelp: 'Организационное подчинение: manager → subordinate. Communication автоматически не создаётся.', edgeCommunicationHelp: 'Разрешённое направление agent-to-agent. Authority при этом не меняется.',
      sourceSelectedAuthority: 'Источник Authority выбран. Теперь выберите подчинённый узел.', sourceSelectedCommunication: 'Первый AgentNode для Communication выбран. Теперь выберите второй.', edgeCreated: 'Связь {kind} создана.', edgeExists: 'Такая связь уже существует.', selfEdgeBlocked: 'Связь узла с самим собой запрещена.',
      savedToast: 'TeamDefinition и TeamLayout отдельно сохранены в browser storage.', resetToast: 'Прототип сброшен.', demoLoaded: 'Демо-команда загружена.', deleteNodeToast: 'AgentNode удалён.', deleteEdgeToast: 'Связь удалена.',
      startBlocked: 'Запуск заблокирован ошибками проверки.', starting: 'Mock TeamRun запускается…', running: 'Mock TeamRun запущен.', paused: 'Mock TeamRun приостановлен.', resumed: 'Mock TeamRun продолжен.', stopped: 'Mock TeamRun остановлен. Редактирование снова доступно.',
      runtimeRunningHelp: 'Только mock runtime. Статусы AgentNode имитируют будущий TeamRun поверх DSH.', runtimePausedHelp: 'Mock TeamRun на паузе. Live schema editing остаётся за пределами P0/MVP.', runtimeStartingHelp: 'Валидная TeamDefinition принята. Имитируются runtime bindings…',
      chatMock: 'Open Chat в P0 — mock action. Production откроет настоящую DSH Session.', editLocked: 'Остановите mock TeamRun перед редактированием TeamDefinition.',
      allow: 'Разрешить', deny: 'Запретить', unset: 'Не задано', entry: 'Entry', newAgent: 'Агент {n}', newRole: 'Участник команды',
      confirmReset: 'Сбросить прототип и удалить сохранённое состояние браузера?',
      errorMissingEntry: 'Entry Agent не назначен.', errorEntryMissingNode: 'Entry Agent ссылается на отсутствующий AgentNode.', errorDuplicateName: 'Повторяющееся technical name: {name}.', errorRequiredField: 'Поле «{field}» обязательно.',
      errorInvalidModel: 'Модель {provider}/{model} отсутствует в mock-каталоге.', errorInvalidReasoning: 'Reasoning effort {value} не поддерживается моделью {provider}/{model}.', errorInvalidCapability: 'Capability {kind}:{id} отсутствует в mock-каталоге.',
      errorDanglingEdge: 'Связь {kind} содержит отсутствующий endpoint.', errorAuthoritySelf: 'Authority self-edge запрещён.', errorMultipleManagers: 'У {name} больше одного непосредственного manager.', errorAuthorityCycle: 'В Authority-графе обнаружен цикл.',
      technicalNameLabel: 'Техническое имя', displayNameLabel: 'Отображаемое имя', roleLabel: 'Роль', systemPromptLabel: 'Системный промпт',
      inspectorDelete: 'Удалить выбранное', addAgentTitle: 'Добавить AgentNode', zoomOutTitle: 'Уменьшить масштаб', zoomInTitle: 'Увеличить масштаб', fitTitle: 'Вписать граф',
      collapseInspector: 'Свернуть Инспектор', expandInspector: 'Развернуть Инспектор', makeEntry: 'Сделать Entry Agent', currentEntry: 'Текущий Entry Agent', entryAvailable: 'Не является текущим Entry Agent',
      entryCurrentHelp: 'Этот AgentNode получает основной пользовательский канал. Назначение другого узла автоматически перенесёт Entry.', entryOtherHelp: 'Назначить этот AgentNode единственным Entry Agent. Предыдущий Entry будет снят автоматически.',
      connectionAuthorityPrompt: 'Authority · выберите manager, затем subordinate · Esc отменяет', connectionAuthorityTarget: 'Authority · {name} → выберите subordinate · Esc отменяет',
      connectionCommunicationPrompt: 'Communication ↔ · выберите первый AgentNode, затем второй · Esc отменяет', connectionCommunicationTarget: 'Communication ↔ · {name} ↔ выберите второй AgentNode · Esc отменяет', connectionCommunicationPromptOneWay: 'Communication → · выберите отправителя, затем получателя · Esc отменяет', connectionCommunicationTargetOneWay: 'Communication → · {name} → выберите получателя · Esc отменяет',
      definitionDraft: 'Черновик TeamDefinition', layoutDraft: 'Черновик TeamLayout', bothDraft: 'Черновик Definition + Layout'
    }
  });

  const PRODUCTION_LABELS = {
    'en-US': {
      prototypeLabel: 'Native Postman Team Editor', loadDemo: 'Load', reset: 'New', saveAs: 'Save As',
      saved: 'Saved on DSH Host', localDraft: 'Unsaved changes', skillsPreview: 'Skills · scoped loader',
      savedToast: 'Definition and layout saved on DSH Host.', resetToast: 'New native Postman team created.',
      runtimeRunningHelp: 'Real DSH Sessions managed by Postman. The graph shows their current states.',
      runtimePausedHelp: 'Paused: new team work is blocked; existing model turns may finish.',
      runtimeStartingHelp: 'Initializing native Postman Sessions.',
      runtimeStoppedHelp: 'Choose a saved team and a new Postman Leader PTC - Nodes Chat.',
      starting: 'Creating real DSH Sessions...', running: 'Native TeamRun started.',
      paused: 'TeamRun paused.', resumed: 'TeamRun resumed.', stopped: 'TeamRun stopped.',
      openChatHelp: 'Opens the actual DSH Session bound to this AgentNode.',
      nativeSlotsFull: 'All available Postman role slots are already in this team.',
      entryFixed: 'Entry must be the native top-level Postman Leader.',
      chooseChat: 'Open a new DSH Chat using the Postman Leader PTC - Nodes preset first.',
      confirmReset: 'Discard unsaved changes and create a new saved team?',
      errorInvalidModel: 'Model {provider}/{model} is not present in the live DSH catalog.',
      errorInvalidCapability: 'Tool {kind}:{id} is unavailable in DSH.'
    },
    'ru-RU': {
      prototypeLabel: 'Редактор настоящей команды Postman', loadDemo: 'Загрузить', reset: 'Новая', saveAs: 'Сохранить как',
      saved: 'Сохранено в DSH', localDraft: 'Не сохранено', skillsPreview: 'Навыки · загрузчик сеанса',
      savedToast: 'Схема и расположение нод сохранены в DSH.', resetToast: 'Создана новая схема Postman.',
      runtimeRunningHelp: 'Настоящие сеансы DSH под управлением Postman. На графе показаны текущие состояния.',
      runtimePausedHelp: 'Пауза: новые поручения запрещены, уже выполняемые запросы могут завершиться.',
      runtimeStartingHelp: 'Создаются штатные сеансы Postman.',
      runtimeStoppedHelp: 'Выберите команду и новый чат с пресетом Postman Leader PTC - Nodes.',
      starting: 'Создаются настоящие сеансы DSH...', running: 'Команда Postman запущена.',
      paused: 'Команда поставлена на паузу.', resumed: 'Команда продолжила работу.', stopped: 'Команда остановлена.',
      openChatHelp: 'Открывает настоящий чат DSH, связанный с этой нодой.',
      nativeSlotsFull: 'Все доступные штатные роли Postman уже включены.',
      entryFixed: 'Главной нодой может быть только настоящий руководитель Postman.',
      chooseChat: 'Откройте новый чат DSH с пресетом Postman Leader PTC - Nodes.',
      confirmReset: 'Отбросить несохранённые правки и создать новую команду?',
      errorInvalidModel: 'Модель {provider}/{model} отсутствует в настоящем каталоге DSH.',
      errorInvalidCapability: 'Инструмент {kind}:{id} недоступен в DSH.'
    }
  };

  const state = {
    locale: localStorage.getItem(STORAGE_KEYS.locale) || 'ru-RU',
    definition: null,
    layout: null,
    runtime: { status: 'STOPPED', id: null, bindings: {} },
    selection: null,
    edgeMode: 'select',
    communicationDirection: 'bidirectional',
    edgeSourceId: null,
    validation: { hasRun: false, errors: [] },
    dirty: { definition: false, layout: false },
    persisted: false,
    ui: { inspectorCollapsed: true, statusDockCollapsed: true },
    interaction: { nodeDrag: null, pan: null }
  };

  const $ = (id) => root.querySelector('#' + id);
  const els = {};
  const ids = [
    'teamName','saveState','loadDemoButton','resetButton','saveButton','validateButton','validateButtonLabel','validateButtonStatus','startButton','pauseButton','resumeButton','stopButton',
    'workspace','addNodeButton','emptyAddButton','communicationDirectionControl','zoomOutButton','zoomInButton','fitButton','zoomReadout','canvasSettingsButton','canvasSettingsPopover','gridVisibleInput','gridStyleSelect','gridSizeSelect','snapNodesInput','alignNodesButton','canvasShell','canvasStage','canvasWorld','canvasEmpty','nodeLayer','edgeGroup','draftEdge','canvasHint','connectionBanner',
    'inspectorTitle','inspectorEmpty','nodeInspector','edgeInspector','inspectorCollapseButton','deleteSelectionButton','agentDetailsDisclosure','nodeIdLabel','technicalNameInput','displayNameInput','roleInput','systemPromptInput',
    'providerSelect','modelSelect','reasoningSelect','capabilityList','entryControl','entryAgentStatus','entryAgentHelp','makeEntryButton','inspectorRuntimeStatus','inspectorStatusDot','openChatButton','openChatHelp',
    'edgeKindBadge','edgeSummary','edgeDirectionNote','edgeDescription','deleteEdgeButton','statusDock','dockToggle','validationSummary','validationBadge','validationList','runPill','runStateLabel','runIdLabel','runtimeCopy',
    'metricAgents','metricAuthority','metricCommunication','compactMetricAgents','compactMetricAuthority','compactMetricCommunication','toastStack','smokeResult'
  ];
  ids.forEach((id) => { els[id] = $(id); });

  function uid(prefix) {
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${Date.now().toString(36)}_${random}`;
  }

  function t(key, vars = {}) {
    const dict = I18N[state.locale] || I18N['en-US'];
    let value = PRODUCTION_LABELS[state.locale]?.[key] || dict[key] || I18N['en-US'][key] || key;
    Object.entries(vars).forEach(([name, replacement]) => {
      value = value.replaceAll(`{${name}}`, String(replacement));
    });
    return value;
  }

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function deepClone(value) { return JSON.parse(JSON.stringify(value)); }
  function getAgent(id) { return state.definition.agents.find((agent) => agent.id === id) || null; }
  function isEditingLocked() { return state.runtime.status !== 'STOPPED' && state.runtime.status !== 'FAILED'; }

  function createEmptyTeam() {
    const teamId = uid('team');
    return {
      definition: {
        schemaVersion: 1,
        id: teamId,
        revision: 0,
        name: 'Software Team',
        description: '',
        entryAgentId: null,
        agents: [],
        authorityEdges: [],
        communicationEdges: []
      },
      layout: {
        schemaVersion: 1,
        teamId,
        viewport: { x: 120, y: 80, zoom: 1 },
        nodes: {},
        visual: { inspectorCollapsed: true, statusDockCollapsed: true, gridVisible: true, gridStyle: 'dots', gridSize: 18, snapNodes: false, edgeRouting: 'free' }
      }
    };
  }

  function loadInitialState() {
    const initial = createEmptyTeam();
    state.definition = initial.definition;
    state.layout = initial.layout;
    normalizeState();
    state.ui = { inspectorCollapsed: false, statusDockCollapsed: false };
    state.dirty = { definition: false, layout: false };
  }

  function applyLoadedTeam(team) {
    state.definition = deepClone(team.definition);
    state.layout = deepClone(team.layout);
    normalizeState();
    state.selection = { type: 'node', id: state.definition.entryAgentId };
    state.edgeSourceId = null;
    state.dirty = { definition: false, layout: false };
    state.persisted = true;
    state.validation = { hasRun: false, errors: [] };
    resetRuntime();
    els.teamName.value = state.definition.name;
    renderAll();
  }

  async function refreshTeams(preferred) {
    const teams = await bridge.call('teams/list');
    const picker = $('teamPicker');
    picker.replaceChildren();
    for (const team of teams) {
      const item = document.createElement('option');
      item.value = team.id; item.textContent = team.name;
      picker.append(item);
    }
    if (preferred && teams.some(t => t.id === preferred)) picker.value = preferred;
    return teams;
  }

  async function initializeFromHost() {
    try {
      const catalog = await bridge.call('catalog');
      MODEL_CATALOG = Object.fromEntries(catalog.models.map(p => [p.provider, p.models]));
      CAPABILITY_CATALOG = [...catalog.tools.map(tool => ({ kind: 'tool', id: tool.name })),
        ...(catalog.skills?.items || []).map(skill => ({ kind:'skill', id:skill.name }))];
      NATIVE_SLOTS = catalog.nativeSlots || [];
      const teams = await refreshTeams();
      if (!teams.length) throw Error('No saved native Postman team was returned by the Host');
      const team = await bridge.call('teams/get', { id: teams[0].id });
      applyLoadedTeam(team);
      await syncRun();
    } catch (e) { toast(String(e.message || e), 'error'); }
  }

  function normalizeState() {
    state.definition.schemaVersion = 1;
    state.definition.revision = Number.isFinite(state.definition.revision) ? state.definition.revision : 0;
    state.definition.agents = Array.isArray(state.definition.agents) ? state.definition.agents : [];
    state.definition.authorityEdges = Array.isArray(state.definition.authorityEdges) ? state.definition.authorityEdges : [];
    state.definition.communicationEdges = Array.isArray(state.definition.communicationEdges) ? state.definition.communicationEdges : [];
    state.layout.schemaVersion = 1;
    state.layout.teamId = state.definition.id;
    state.layout.viewport = state.layout.viewport || { x: 120, y: 80, zoom: 1 };
    state.layout.viewport.zoom = clamp(Number(state.layout.viewport.zoom) || 1, MIN_ZOOM, MAX_ZOOM);
    state.layout.nodes = state.layout.nodes || {};
    state.layout.visual = state.layout.visual || {};
    if (typeof state.layout.visual.inspectorCollapsed !== 'boolean') state.layout.visual.inspectorCollapsed = true;
    if (typeof state.layout.visual.statusDockCollapsed !== 'boolean') state.layout.visual.statusDockCollapsed = true;
    if (typeof state.layout.visual.gridVisible !== 'boolean') state.layout.visual.gridVisible = true;
    if (!['dots','lines'].includes(state.layout.visual.gridStyle)) state.layout.visual.gridStyle = 'dots';
    if (![12,18,24,36].includes(Number(state.layout.visual.gridSize))) state.layout.visual.gridSize = 18;
    state.layout.visual.gridSize = Number(state.layout.visual.gridSize);
    if (typeof state.layout.visual.snapNodes !== 'boolean') state.layout.visual.snapNodes = false;
    if (!['free','orthogonal'].includes(state.layout.visual.edgeRouting)) state.layout.visual.edgeRouting = 'free';
    state.definition.agents.forEach((agent, index) => {
      agent.capabilities = agent.capabilities || { grants: [] };
      agent.capabilities.grants = Array.isArray(agent.capabilities.grants) ? agent.capabilities.grants : [];
      if (!state.layout.nodes[agent.id]) state.layout.nodes[agent.id] = { x: 180 + (index % 3) * 280, y: 120 + Math.floor(index / 3) * 200 };
    });
  }

  function applyI18n() {
    root.querySelectorAll('[data-i18n]').forEach((element) => {
      element.textContent = t(element.dataset.i18n);
    });
    root.querySelectorAll('[data-locale-action]').forEach((button) => button.classList.toggle('is-active', button.dataset.localeAction === state.locale));
    els.addNodeButton.title = t('addAgentTitle');
    els.zoomOutButton.title = t('zoomOutTitle');
    els.zoomInButton.title = t('zoomInTitle');
    els.fitButton.title = t('fitTitle');
    els.canvasSettingsButton.title = t('canvasSettingsTitle');
    els.deleteSelectionButton.title = t('inspectorDelete');
    els.validateButtonLabel.textContent = t('validate');
    updateConnectionBanner();
    applyVisualState();
    renderInspector();
    renderValidation();
    renderRuntime();
    renderEdges();
    renderDirtyState();
  }

  function setLocale(locale) {
    if (!I18N[locale]) return;
    state.locale = locale;
    localStorage.setItem(STORAGE_KEYS.locale, locale);
    applyI18n();
  }

  function renderDirtyState() {
    if (state.dirty.definition && state.dirty.layout) els.saveState.textContent = t('bothDraft');
    else if (state.dirty.definition) els.saveState.textContent = t('definitionDraft');
    else if (state.dirty.layout) els.saveState.textContent = t('layoutDraft');
    else els.saveState.textContent = state.persisted ? t('saved') : t('localDraft');
  }

  function markDefinitionDirty() {
    state.dirty.definition = true;
    state.validation.hasRun = false;
    state.validation.errors = [];
    renderValidation();
    renderDirtyState();
  }

  function markLayoutDirty() {
    state.dirty.layout = true;
    renderDirtyState();
  }

  async function saveTeam({ silent = false } = {}) {
    state.definition.name = els.teamName.value.trim() || 'Untitled Team';
    try {
      if (state.dirty.definition) {
        const saved = await bridge.call('teams/save', { definition: state.definition, layout: state.layout, expectedRevision: state.definition.revision });
        state.definition = saved.definition; state.layout = saved.layout;
      } else if (state.dirty.layout) {
        await bridge.call('layouts/save', { layout: state.layout });
      }
      state.dirty = { definition: false, layout: false };
      state.persisted = true;
      await refreshTeams(state.definition.id);
      renderDirtyState();
      if (!silent) toast(t('savedToast'), 'success');
      return true;
    } catch (e) { toast(String(e.message || e), 'error'); return false; }
  }

  async function saveAsTeam() {
    if (isEditingLocked()) return lockedToast();
    try {
      const saved = await bridge.call('teams/save-as', { definition: state.definition, layout: state.layout });
      applyLoadedTeam(saved);
      await refreshTeams(saved.definition.id);
      toast(t('savedToast'), 'success');
    } catch (e) { toast(String(e.message || e), 'error'); }
  }

  async function loadDemo() {
    if (isEditingLocked()) return lockedToast();
    try {
      const team = await bridge.call('teams/get', { id: $('teamPicker').value });
      applyLoadedTeam(team);
      await syncRun();
    } catch (e) { toast(String(e.message || e), 'error'); }
  }

  async function resetPrototype(force = false) {
    if (isEditingLocked()) return lockedToast();
    if (!force && (state.dirty.definition || state.dirty.layout) && !window.confirm(t('confirmReset'))) return;
    try {
      const team = await bridge.call('teams/new');
      applyLoadedTeam(team);
      await refreshTeams(team.definition.id);
      toast(t('resetToast'));
    } catch (e) { toast(String(e.message || e), 'error'); }
  }

  function createAgent({ x, y } = {}) {
    if (isEditingLocked()) return lockedToast();
    const native = NATIVE_SLOTS.find(slot => slot.id !== 'entry' && !state.definition.agents.some(a => a.slot === slot.id) &&
      state.definition.agents.some(a => a.slot === slot.owner));
    if (!native) { toast(t('nativeSlotsFull'), 'error'); return null; }
    const parent = state.definition.agents.find(a => a.slot === native.owner);
    const model = (MODEL_CATALOG.codex || []).find(m => m.id === native.model);
    const agent = { id: uid('agent'), slot: native.id, technicalName: native.id.replaceAll('-', '_'),
      displayName: native.label, role: native.label,
      systemPrompt: 'Follow your native Postman role and report concrete evidence to your manager.',
      model: { provider: 'codex', model: native.model, reasoningEffort: native.reasoning || model?.reasoningEfforts?.[0] || '' },
      capabilities: { grants: [] } };
    state.definition.agents.push(agent);
    state.definition.authorityEdges.push({ id: uid('auth'), from: parent.id, to: agent.id });
    state.definition.communicationEdges.push({ id: uid('comm'), from: parent.id, to: agent.id });
    state.definition.communicationEdges.push({ id: uid('comm'), from: agent.id, to: parent.id });
    const view = state.layout.viewport;
    const n = state.definition.agents.length;
    let px = Number.isFinite(x) ? x : (els.canvasShell.clientWidth / 2 - view.x) / view.zoom - NODE_WIDTH / 2 + (n % 4) * 24;
    let py = Number.isFinite(y) ? y : (els.canvasShell.clientHeight / 2 - view.y) / view.zoom - NODE_HEIGHT / 2 + (n % 4) * 24;
    if (state.layout.visual.snapNodes) { px = snapGridValue(px); py = snapGridValue(py); }
    state.layout.nodes[agent.id] = { x: clamp(px, 20, STAGE_WIDTH - NODE_WIDTH - 20), y: clamp(py, 20, STAGE_HEIGHT - NODE_HEIGHT - 20) };
    state.selection = { type: 'node', id: agent.id };
    state.ui.inspectorCollapsed = false;
    markDefinitionDirty(); markLayoutDirty(); renderAll();
    return agent;
  }

  function deleteSelection() {
    if (!state.selection) return;
    if (isEditingLocked()) return lockedToast();
    if (state.selection.type === 'node') deleteNode(state.selection.id);
    if (state.selection.type === 'edge') deleteEdge(state.selection.id, state.selection.kind, state.selection.pairId || null);
  }

  function deleteNode(id) {
    state.definition.agents = state.definition.agents.filter((agent) => agent.id !== id);
    state.definition.authorityEdges = state.definition.authorityEdges.filter((edge) => edge.from !== id && edge.to !== id);
    state.definition.communicationEdges = state.definition.communicationEdges.filter((edge) => edge.from !== id && edge.to !== id);
    delete state.layout.nodes[id];
    if (state.definition.entryAgentId === id) state.definition.entryAgentId = null;
    state.selection = null;
    state.edgeSourceId = null;
    markDefinitionDirty();
    markLayoutDirty();
    renderAll();
    toast(t('deleteNodeToast'));
  }

  function deleteEdge(id, kind, pairId = null) {
    const key = kind === 'authority' ? 'authorityEdges' : 'communicationEdges';
    const ids = new Set([id, pairId].filter(Boolean));
    state.definition[key] = state.definition[key].filter((edge) => !ids.has(edge.id));
    state.selection = null;
    markDefinitionDirty();
    renderAll();
    toast(t('deleteEdgeToast'));
  }

  function setCommunicationDirection(direction) {
    if (!['bidirectional', 'oneway'].includes(direction)) return;
    state.communicationDirection = direction;
    root.querySelectorAll('[data-communication-direction]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.communicationDirection === direction);
    });
    updateConnectionBanner();
  }

  function setEdgeMode(mode) {
    if (!['select', 'authority', 'communication'].includes(mode)) return;
    state.edgeMode = mode;
    state.edgeSourceId = null;
    root.querySelectorAll('[data-edge-mode]').forEach((button) => button.classList.toggle('is-active', button.dataset.edgeMode === mode));
    els.communicationDirectionControl.hidden = mode !== 'communication';
    els.canvasShell.classList.toggle('edge-authority', mode === 'authority');
    els.canvasShell.classList.toggle('edge-communication', mode === 'communication');
    updateConnectionBanner();
    renderNodes();
  }

  function handleNodeAction(id) {
    if (state.edgeMode === 'select') {
      state.selection = { type: 'node', id };
      setInspectorCollapsed(false, { mark: false });
      renderSelection();
      return;
    }
    if (isEditingLocked()) return lockedToast();
    if (!state.edgeSourceId) {
      state.edgeSourceId = id;
      state.selection = { type: 'node', id };
      updateConnectionBanner();
      renderSelection();
      toast(t(state.edgeMode === 'authority' ? 'sourceSelectedAuthority' : 'sourceSelectedCommunication'));
      return;
    }
    const from = state.edgeSourceId;
    const to = id;
    if (from === to) {
      toast(t('selfEdgeBlocked'), 'error');
      state.edgeSourceId = null;
      updateConnectionBanner();
      renderNodes();
      return;
    }
    const key = state.edgeMode === 'authority' ? 'authorityEdges' : 'communicationEdges';
    if (state.edgeMode === 'communication' && state.communicationDirection === 'bidirectional') {
      const forwardExists = state.definition.communicationEdges.some((edge) => edge.from === from && edge.to === to);
      const reverseExists = state.definition.communicationEdges.some((edge) => edge.from === to && edge.to === from);
      if (forwardExists && reverseExists) {
        toast(t('edgeExists'), 'error');
      } else {
        if (!forwardExists) state.definition.communicationEdges.push({ id: uid('comm'), from, to });
        if (!reverseExists) state.definition.communicationEdges.push({ id: uid('comm'), from: to, to: from });
        markDefinitionDirty();
        toast(t('edgeCreated', { kind: t('bidirectionalConnection') }), 'success');
      }
    } else if (state.definition[key].some((edge) => edge.from === from && edge.to === to)) {
      toast(t('edgeExists'), 'error');
    } else {
      const prefix = state.edgeMode === 'authority' ? 'auth' : 'comm';
      state.definition[key].push({ id: uid(prefix), from, to });
      markDefinitionDirty();
      const kind = state.edgeMode === 'authority' ? 'Authority' : t('oneWayConnection');
      toast(t('edgeCreated', { kind }), 'success');
    }
    state.edgeSourceId = null;
    state.selection = null;
    updateConnectionBanner();
    renderAll();
  }

  function applyVisualState() {
    const ui = state.ui || { inspectorCollapsed: true, statusDockCollapsed: true };
    els.workspace.classList.toggle('inspector-collapsed', Boolean(ui.inspectorCollapsed));
    els.statusDock.classList.toggle('collapsed', Boolean(ui.statusDockCollapsed));
    els.inspectorCollapseButton.textContent = ui.inspectorCollapsed ? '›' : '‹';
    els.inspectorCollapseButton.setAttribute('aria-expanded', String(!ui.inspectorCollapsed));
    els.inspectorCollapseButton.title = t(ui.inspectorCollapsed ? 'expandInspector' : 'collapseInspector');
    els.dockToggle.setAttribute('aria-expanded', String(!ui.statusDockCollapsed));
    if (els.gridVisibleInput) els.gridVisibleInput.checked = Boolean(state.layout.visual.gridVisible);
    if (els.gridStyleSelect) els.gridStyleSelect.value = state.layout.visual.gridStyle;
    if (els.gridSizeSelect) els.gridSizeSelect.value = String(state.layout.visual.gridSize);
    if (els.snapNodesInput) els.snapNodesInput.checked = Boolean(state.layout.visual.snapNodes);
    root.querySelectorAll('[data-routing-mode]').forEach((button) => button.classList.toggle('is-active', button.dataset.routingMode === state.layout.visual.edgeRouting));
  }

  function setInspectorCollapsed(collapsed, { mark = true } = {}) {
    const value = Boolean(collapsed);
    state.ui.inspectorCollapsed = value;
    if (mark) state.layout.visual.inspectorCollapsed = value;
    applyVisualState();
    if (mark) markLayoutDirty();
    requestAnimationFrame(() => renderEdges());
  }

  function setStatusDockCollapsed(collapsed, { mark = true } = {}) {
    const value = Boolean(collapsed);
    state.ui.statusDockCollapsed = value;
    if (mark) state.layout.visual.statusDockCollapsed = value;
    applyVisualState();
    if (mark) markLayoutDirty();
    requestAnimationFrame(() => renderEdges());
  }

  function setCanvasSettingsOpen(open) {
    const visible = Boolean(open);
    els.canvasSettingsPopover.hidden = !visible;
    els.canvasSettingsButton.classList.toggle('is-active', visible);
    els.canvasSettingsButton.setAttribute('aria-expanded', String(visible));
  }

  function setLayoutVisual(key, value, { rerenderEdges = false, rerenderGrid = false } = {}) {
    state.layout.visual[key] = value;
    applyVisualState();
    if (rerenderGrid) applyViewport();
    if (rerenderEdges) renderEdges();
    markLayoutDirty();
  }

  function gridSize() { return Number(state.layout.visual.gridSize) || 18; }
  function snapGridValue(value) {
    const size = gridSize();
    return Math.round(value / size) * size;
  }

  function alignNodesToGrid() {
    if (isEditingLocked()) return lockedToast();
    for (const agent of state.definition.agents) {
      const pos = state.layout.nodes[agent.id];
      if (!pos) continue;
      pos.x = clamp(snapGridValue(pos.x), 8, STAGE_WIDTH - NODE_WIDTH - 8);
      pos.y = clamp(snapGridValue(pos.y), 8, STAGE_HEIGHT - NODE_HEIGHT - 8);
    }
    markLayoutDirty();
    renderNodes();
    renderEdges();
  }

  function updateConnectionBanner() {
    if (state.edgeMode === 'select') {
      els.connectionBanner.hidden = true;
      els.connectionBanner.textContent = '';
      els.connectionBanner.className = 'connection-banner';
      return;
    }
    const source = state.edgeSourceId ? getAgent(state.edgeSourceId) : null;
    const key = state.edgeMode === 'authority'
      ? (source ? 'connectionAuthorityTarget' : 'connectionAuthorityPrompt')
      : state.communicationDirection === 'oneway'
        ? (source ? 'connectionCommunicationTargetOneWay' : 'connectionCommunicationPromptOneWay')
        : (source ? 'connectionCommunicationTarget' : 'connectionCommunicationPrompt');
    els.connectionBanner.textContent = t(key, { name: source?.displayName || source?.technicalName || 'AgentNode' });
    els.connectionBanner.className = `connection-banner ${state.edgeMode}`;
    els.connectionBanner.hidden = false;
  }

  function renderAll() {
    els.teamName.value = state.definition.name || 'Software Team';
    applyVisualState();
    applyViewport();
    renderNodes();
    renderEdges();
    renderInspector();
    renderValidation();
    renderRuntime();
    els.canvasEmpty.hidden = state.definition.agents.length > 0;
    els.metricAgents.textContent = state.definition.agents.length;
    els.metricAuthority.textContent = state.definition.authorityEdges.length;
    els.metricCommunication.textContent = state.definition.communicationEdges.length;
    els.compactMetricAgents.textContent = state.definition.agents.length;
    els.compactMetricAuthority.textContent = state.definition.authorityEdges.length;
    els.compactMetricCommunication.textContent = state.definition.communicationEdges.length;
    renderDirtyState();
    updateConnectionBanner();
  }

  function renderNodes() {
    els.nodeLayer.replaceChildren();
    for (const agent of state.definition.agents) {
      const position = state.layout.nodes[agent.id] || { x: 100, y: 100 };
      const runtimeStatus = state.runtime.bindings[agent.id]?.status || (state.runtime.status === 'STOPPED' ? 'NOT_STARTED' : 'IDLE');
      const node = document.createElement('article');
      node.className = 'agent-node';
      node.dataset.id = agent.id;
      node.dataset.runtime = runtimeStatus;
      node.style.left = `${position.x}px`;
      node.style.top = `${position.y}px`;
      if (state.selection?.type === 'node' && state.selection.id === agent.id) node.classList.add('selected');
      if (state.definition.entryAgentId === agent.id) node.classList.add('entry');
      if (state.selection?.type === 'edge') {
        const selectedEdge = edgeCollection(state.selection.kind).find((edge) => edge.id === state.selection.id);
        if (selectedEdge && (selectedEdge.from === agent.id || selectedEdge.to === agent.id)) node.classList.add('edge-peer');
      }
      if (state.edgeSourceId === agent.id) node.classList.add(state.edgeMode === 'authority' ? 'edge-source-authority' : 'edge-source-communication');
      else if (state.edgeSourceId && state.edgeMode !== 'select') node.classList.add('edge-target-candidate');

      const strip = document.createElement('div');
      strip.className = 'node-runtime-strip';
      const body = document.createElement('div');
      body.className = 'node-body';
      const top = document.createElement('div');
      top.className = 'node-topline';
      const titleWrap = document.createElement('div');
      titleWrap.className = 'node-title-wrap';
      const title = document.createElement('div');
      title.className = 'node-title';
      title.textContent = agent.displayName || '—';
      const role = document.createElement('div');
      role.className = 'node-role';
      role.textContent = agent.role || '—';
      titleWrap.append(title, role);
      top.append(titleWrap);
      if (state.definition.entryAgentId === agent.id) {
        const badge = document.createElement('span');
        badge.className = 'entry-badge';
        badge.textContent = t('entry');
        top.append(badge);
      }
      const meta = document.createElement('div');
      meta.className = 'node-meta';
      const model = document.createElement('div');
      model.className = 'model-chip';
      model.textContent = agent.model?.model || '—';
      const runtime = document.createElement('div');
      runtime.className = 'runtime-chip';
      const dot = document.createElement('span');
      dot.className = 'runtime-dot';
      const runtimeText = document.createElement('span');
      runtimeText.textContent = runtimeStatus;
      runtime.append(dot, runtimeText);
      meta.append(model, runtime);
      body.append(top, meta);
      const authorityInPort = document.createElement('span');
      authorityInPort.className = 'node-port authority in';
      authorityInPort.setAttribute('aria-hidden', 'true');
      const authorityOutPort = document.createElement('span');
      authorityOutPort.className = 'node-port authority out';
      authorityOutPort.setAttribute('aria-hidden', 'true');
      const communicationInPort = document.createElement('span');
      communicationInPort.className = 'node-port communication in';
      communicationInPort.setAttribute('aria-hidden', 'true');
      const communicationOutPort = document.createElement('span');
      communicationOutPort.className = 'node-port communication out';
      communicationOutPort.setAttribute('aria-hidden', 'true');
      node.append(strip, body, authorityInPort, authorityOutPort, communicationInPort, communicationOutPort);

      node.addEventListener('pointerdown', (event) => onNodePointerDown(event, agent.id));
      node.addEventListener('click', (event) => {
        if (state.interaction.nodeDrag?.moved) return;
        event.stopPropagation();
        handleNodeAction(agent.id);
      });
      els.nodeLayer.append(node);
    }
  }

  function onNodePointerDown(event, id) {
    if (event.button !== 0 || state.edgeMode !== 'select' || isEditingLocked()) return;
    event.stopPropagation();
    const pos = state.layout.nodes[id];
    state.interaction.nodeDrag = {
      id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: pos.x,
      startY: pos.y,
      moved: false
    };
    const node = event.currentTarget;
    node.setPointerCapture(event.pointerId);
    node.classList.add('dragging');
    const move = (moveEvent) => {
      const drag = state.interaction.nodeDrag;
      if (!drag) return;
      const dx = (moveEvent.clientX - drag.startClientX) / state.layout.viewport.zoom;
      const dy = (moveEvent.clientY - drag.startClientY) / state.layout.viewport.zoom;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      let nextX = drag.startX + dx;
      let nextY = drag.startY + dy;
      if (state.layout.visual.snapNodes) {
        nextX = snapGridValue(nextX);
        nextY = snapGridValue(nextY);
      }
      state.layout.nodes[id] = {
        x: clamp(nextX, 8, STAGE_WIDTH - NODE_WIDTH - 8),
        y: clamp(nextY, 8, STAGE_HEIGHT - NODE_HEIGHT - 8)
      };
      node.style.left = `${state.layout.nodes[id].x}px`;
      node.style.top = `${state.layout.nodes[id].y}px`;
      renderEdges();
    };
    const up = () => {
      node.classList.remove('dragging');
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      if (state.interaction.nodeDrag?.moved) markLayoutDirty();
      setTimeout(() => { state.interaction.nodeDrag = null; }, 0);
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
  }

  function edgeCollection(kind) {
    return kind === 'authority' ? state.definition.authorityEdges : state.definition.communicationEdges;
  }

  function cleanOrthogonalPoints(points) {
    const deduped = [];
    for (const point of points) {
      const prev = deduped[deduped.length - 1];
      if (!prev || prev.x !== point.x || prev.y !== point.y) deduped.push(point);
    }
    let changed = true;
    while (changed && deduped.length > 2) {
      changed = false;
      for (let i = 1; i < deduped.length - 1; i += 1) {
        const a = deduped[i - 1], b = deduped[i], c = deduped[i + 1];
        if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) {
          deduped.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    return deduped;
  }

  function roundedOrthogonalPath(points, radius = 10) {
    const pts = cleanOrthogonalPoints(points);
    if (pts.length < 2) return '';
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i += 1) {
      const prev = pts[i - 1];
      const cur = pts[i];
      const next = pts[i + 1];
      const lenIn = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      const lenOut = Math.hypot(next.x - cur.x, next.y - cur.y);
      const r = Math.max(0, Math.min(radius, lenIn / 2, lenOut / 2));
      if (!r) { d += ` L ${cur.x} ${cur.y}`; continue; }
      const inX = cur.x + (prev.x - cur.x) / lenIn * r;
      const inY = cur.y + (prev.y - cur.y) / lenIn * r;
      const outX = cur.x + (next.x - cur.x) / lenOut * r;
      const outY = cur.y + (next.y - cur.y) / lenOut * r;
      d += ` L ${inX} ${inY} Q ${cur.x} ${cur.y} ${outX} ${outY}`;
    }
    const last = pts[pts.length - 1];
    d += ` L ${last.x} ${last.y}`;
    return d;
  }

  function orthogonalEdgePath(kind, edge, fromPos, toPos, collection) {
    const step = gridSize();
    const radius = Math.min(12, Math.max(6, step * 0.45));
    if (kind === 'authority') {
      const from = { x: fromPos.x + NODE_WIDTH / 2, y: fromPos.y + NODE_HEIGHT };
      const to = { x: toPos.x + NODE_WIDTH / 2, y: toPos.y };
      const outY = snapGridValue(from.y + step);
      const inY = snapGridValue(to.y - step);
      let points;
      if (to.y - from.y >= step * 3) {
        const midY = snapGridValue((outY + inY) / 2);
        points = [from, { x: from.x, y: midY }, { x: to.x, y: midY }, to];
      } else {
        const direction = to.x >= from.x ? 1 : -1;
        const sideX = snapGridValue(direction > 0
          ? Math.max(fromPos.x + NODE_WIDTH, toPos.x + NODE_WIDTH) + step * 2
          : Math.min(fromPos.x, toPos.x) - step * 2);
        points = [from, { x: from.x, y: outY }, { x: sideX, y: outY }, { x: sideX, y: inY }, { x: to.x, y: inY }, to];
      }
      return roundedOrthogonalPath(points, radius);
    }

    const from = { x: fromPos.x + NODE_WIDTH, y: fromPos.y + NODE_HEIGHT / 2 };
    const to = { x: toPos.x, y: toPos.y + NODE_HEIGHT / 2 };
    const outX = snapGridValue(from.x + step);
    const inX = snapGridValue(to.x - step);
    let points;
    if (to.x - from.x >= step * 3) {
      let midX = snapGridValue((outX + inX) / 2);
      const reciprocal = collection.some((candidate) => candidate.from === edge.to && candidate.to === edge.from);
      if (reciprocal) midX += (String(edge.from) < String(edge.to) ? -1 : 1) * step;
      points = [from, { x: midX, y: from.y }, { x: midX, y: to.y }, to];
    } else {
      const routeAbove = to.y <= from.y;
      const laneY = snapGridValue(routeAbove
        ? Math.min(fromPos.y, toPos.y) - step * 2
        : Math.max(fromPos.y + NODE_HEIGHT, toPos.y + NODE_HEIGHT) + step * 2);
      points = [from, { x: outX, y: from.y }, { x: outX, y: laneY }, { x: inX, y: laneY }, { x: inX, y: to.y }, to];
    }
    return roundedOrthogonalPath(points, radius);
  }

  function communicationReciprocal(edge, collection) {
    return collection.find((candidate) => candidate.id !== edge.id && candidate.from === edge.to && candidate.to === edge.from) || null;
  }

  function renderEdges() {
    els.edgeGroup.replaceChildren();
    renderEdgeKind('authority');
    renderEdgeKind('communication');
  }

  function renderEdgeKind(kind) {
    const collection = edgeCollection(kind);
    const focusActive = state.selection?.type === 'node' || state.selection?.type === 'edge';
    const processed = new Set();
    for (const edge of collection) {
      if (processed.has(edge.id)) continue;
      let visualEdge = edge;
      let pair = null;
      let isBidirectional = false;
      let fromPos = state.layout.nodes[edge.from];
      let toPos = state.layout.nodes[edge.to];
      if (!fromPos || !toPos) continue;

      if (kind === 'communication') {
        pair = communicationReciprocal(edge, collection);
        if (pair) {
          isBidirectional = true;
          processed.add(pair.id);
          const edgeFromPos = state.layout.nodes[edge.from];
          const edgeToPos = state.layout.nodes[edge.to];
          const edgeFromCenterX = edgeFromPos.x + NODE_WIDTH / 2;
          const edgeToCenterX = edgeToPos.x + NODE_WIDTH / 2;
          const edgeFromFirst = edgeFromCenterX < edgeToCenterX || (edgeFromCenterX === edgeToCenterX && edge.from < edge.to);
          visualEdge = edgeFromFirst ? edge : pair;
          fromPos = state.layout.nodes[visualEdge.from];
          toPos = state.layout.nodes[visualEdge.to];
        }
      }
      processed.add(edge.id);

      let d;
      if (state.layout.visual.edgeRouting === 'orthogonal') {
        const routeCollection = isBidirectional ? [visualEdge] : collection;
        d = orthogonalEdgePath(kind, visualEdge, fromPos, toPos, routeCollection);
      } else if (kind === 'authority') {
        const from = { x: fromPos.x + NODE_WIDTH / 2, y: fromPos.y + NODE_HEIGHT };
        const to = { x: toPos.x + NODE_WIDTH / 2, y: toPos.y };
        const curve = Math.max(66, Math.abs(to.y - from.y) * 0.42);
        d = `M ${from.x} ${from.y} C ${from.x} ${from.y + curve}, ${to.x} ${to.y - curve}, ${to.x} ${to.y}`;
      } else {
        const from = { x: fromPos.x + NODE_WIDTH, y: fromPos.y + NODE_HEIGHT / 2 };
        const to = { x: toPos.x, y: toPos.y + NODE_HEIGHT / 2 };
        const reciprocal = !isBidirectional && collection.some((candidate) => candidate.from === visualEdge.to && candidate.to === visualEdge.from);
        const pairSign = String(visualEdge.from) < String(visualEdge.to) ? -1 : 1;
        const bend = reciprocal ? 22 * pairSign : 0;
        const curve = Math.max(76, Math.abs(to.x - from.x) * 0.42);
        d = `M ${from.x} ${from.y} C ${from.x + curve} ${from.y + bend}, ${to.x - curve} ${to.y + bend}, ${to.x} ${to.y}`;
      }
      const pairEdgeId = isBidirectional ? (visualEdge.id === edge.id ? pair?.id : edge.id) : null;
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.dataset.edgeId = visualEdge.id;
      group.dataset.edgeKind = kind;
      if (pairEdgeId) group.dataset.edgePairId = pairEdgeId;
      group.classList.add('edge-group-item');
      const selectedEdge = state.selection?.type === 'edge' && (state.selection.id === visualEdge.id || state.selection.id === pairEdgeId || state.selection.pairId === visualEdge.id || state.selection.pairId === pairEdgeId);
      const relevantToFocus = state.selection?.type === 'node'
        ? visualEdge.from === state.selection.id || visualEdge.to === state.selection.id
        : state.selection?.type === 'edge'
          ? selectedEdge
          : true;
      if (focusActive && !relevantToFocus) group.classList.add('is-dimmed');
      const visible = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      visible.setAttribute('d', d);
      visible.setAttribute('class', `edge ${kind}${isBidirectional ? ' bidirectional' : ''}${selectedEdge ? ' selected' : ''}`);
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('d', d);
      hit.setAttribute('class', 'edge-hit');
      hit.style.pointerEvents = 'stroke';
      hit.addEventListener('click', (event) => {
        event.stopPropagation();
        state.selection = { type: 'edge', id: visualEdge.id, kind, pairId: pairEdgeId || null };
        setInspectorCollapsed(false, { mark: false });
        renderSelection();
      });
      group.append(visible, hit);
      els.edgeGroup.append(group);
    }
  }

  function renderSelection() {
    renderNodes();
    renderEdges();
    renderInspector();
  }

  function renderInspector() {
    const selection = state.selection;
    els.inspectorEmpty.hidden = Boolean(selection);
    els.nodeInspector.hidden = true;
    els.edgeInspector.hidden = true;
    els.deleteSelectionButton.hidden = !selection;
    if (!selection) {
      els.inspectorTitle.textContent = t('nothingSelected');
      return;
    }
    if (selection.type === 'node') {
      const agent = getAgent(selection.id);
      if (!agent) { state.selection = null; return renderInspector(); }
      els.inspectorTitle.textContent = agent.displayName || agent.technicalName || 'AgentNode';
      els.nodeInspector.hidden = false;
      if (els.agentDetailsDisclosure.dataset.agentId !== agent.id) {
        els.agentDetailsDisclosure.open = false;
        els.agentDetailsDisclosure.dataset.agentId = agent.id;
      }
      els.nodeIdLabel.textContent = agent.id;
      els.technicalNameInput.value = agent.technicalName || '';
      els.displayNameInput.value = agent.displayName || '';
      els.roleInput.value = agent.role || '';
      els.systemPromptInput.value = agent.systemPrompt || '';
      populateProviderSelect(agent);
      populateModelSelect(agent);
      populateReasoningSelect(agent);
      renderCapabilities(agent);
      const isEntry = state.definition.entryAgentId === agent.id;
      els.entryControl.classList.toggle('current', isEntry);
      els.entryAgentStatus.textContent = t(isEntry ? 'currentEntry' : 'entryAvailable');
      els.entryAgentStatus.classList.toggle('current', isEntry);
      els.entryAgentHelp.textContent = t('entryFixed');
      els.makeEntryButton.hidden = isEntry || agent.slot !== 'entry';
      els.makeEntryButton.disabled = isEditingLocked();
      const runtimeStatus = state.runtime.bindings[agent.id]?.status || (state.runtime.status === 'STOPPED' ? 'NOT_STARTED' : 'IDLE');
      els.inspectorRuntimeStatus.textContent = runtimeStatus;
      els.inspectorStatusDot.style.background = runtimeStatus === 'RUNNING' ? 'var(--success)' : runtimeStatus === 'PAUSED' ? 'var(--warning)' : runtimeStatus === 'ERROR' ? 'var(--danger)' : '#657184';
      els.openChatButton.disabled = !state.runtime.bindings[agent.id]?.sessionId;
      setInspectorEditingLocked(isEditingLocked());
      return;
    }
    const edge = edgeCollection(selection.kind).find((item) => item.id === selection.id);
    if (!edge) { state.selection = null; return renderInspector(); }
    const from = getAgent(edge.from);
    const to = getAgent(edge.to);
    const reciprocal = selection.kind === 'communication' ? communicationReciprocal(edge, state.definition.communicationEdges) : null;
    const kindLabel = selection.kind === 'authority' ? 'Authority' : 'Communication';
    els.inspectorTitle.textContent = kindLabel;
    els.edgeInspector.hidden = false;
    els.edgeKindBadge.textContent = kindLabel;
    els.edgeKindBadge.className = `edge-kind-badge ${selection.kind}`;
    els.edgeSummary.textContent = `${from?.displayName || edge.from} ${reciprocal ? '↔' : '→'} ${to?.displayName || edge.to}`;
    els.edgeDirectionNote.hidden = selection.kind !== 'communication';
    if (selection.kind === 'communication') {
      els.edgeDirectionNote.textContent = t(reciprocal ? 'bidirectionalConnection' : 'oneWayConnection');
      els.edgeDirectionNote.className = `edge-direction-note${reciprocal ? ' bidirectional' : ''}`;
      state.selection.pairId = reciprocal?.id || null;
    }
    els.edgeDescription.textContent = t(selection.kind === 'authority' ? 'edgeAuthorityHelp' : 'edgeCommunicationHelp');
    els.deleteEdgeButton.disabled = isEditingLocked();
  }

  function setInspectorEditingLocked(locked) {
    const controls = els.nodeInspector.querySelectorAll('input, textarea, select');
    controls.forEach((control) => { control.disabled = locked || control.dataset.nativeFixed === 'true' || control === els.reasoningSelect && control.dataset.unsupported === 'true'; });
    els.openChatButton.disabled = state.selection?.type !== 'node' || !state.runtime.bindings[state.selection.id]?.sessionId;
    els.makeEntryButton.disabled = locked;
    els.deleteSelectionButton.disabled = locked;
  }

  function populateProviderSelect(agent) {
    els.providerSelect.replaceChildren();
    Object.keys(MODEL_CATALOG).forEach((provider) => {
      const option = document.createElement('option');
      option.value = provider;
      option.textContent = provider;
      option.selected = provider === agent.model?.provider;
      els.providerSelect.append(option);
    });
  }

  function populateModelSelect(agent) {
    els.modelSelect.replaceChildren();
    const models = MODEL_CATALOG[agent.model?.provider] || [];
    models.forEach((model) => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.label;
      option.selected = model.id === agent.model?.model;
      els.modelSelect.append(option);
    });
    if (!models.some((model) => model.id === agent.model?.model) && agent.model?.model) {
      const invalid = document.createElement('option');
      invalid.value = agent.model.model;
      invalid.textContent = `${agent.model.model} ⚠`;
      invalid.selected = true;
      els.modelSelect.append(invalid);
    }
  }

  function populateReasoningSelect(agent) {
    els.reasoningSelect.replaceChildren();
    const model = (MODEL_CATALOG[agent.model?.provider] || []).find((item) => item.id === agent.model?.model);
    const efforts = ['', ...(model?.reasoningEfforts || [])];
    els.reasoningSelect.dataset.unsupported = String(!model?.reasoningEfforts?.length);
    els.reasoningSelect.disabled = isEditingLocked() || !model?.reasoningEfforts?.length;
    efforts.forEach((effort) => {
      const option = document.createElement('option');
      option.value = effort;
      option.textContent = effort || (state.locale === 'ru-RU' ? 'По умолчанию' : 'Model default');
      option.selected = effort === agent.model?.reasoningEffort;
      els.reasoningSelect.append(option);
    });
    if (model?.reasoningEfforts?.length && agent.model?.reasoningEffort && !efforts.includes(agent.model.reasoningEffort)) {
      const invalid = document.createElement('option');
      invalid.value = agent.model.reasoningEffort;
      invalid.textContent = `${agent.model.reasoningEffort} ⚠`;
      invalid.selected = true;
      els.reasoningSelect.append(invalid);
    }
  }

  function renderCapabilities(agent) {
    els.capabilityList.replaceChildren();
    for (const capability of CAPABILITY_CATALOG) {
      const matching = agent.capabilities.grants.filter((grant) => grant.kind === capability.kind && grant.id === capability.id);
      const fixed = NATIVE_SLOTS.find(slot => slot.id === agent.slot);
      const required = capability.kind === 'tool' ? fixed?.requiredTools?.includes(capability.id) : capability.id.startsWith('postman-');
      const forbidden = capability.kind === 'tool' && fixed?.deniedTools?.includes(capability.id);
      const mode = forbidden ? 'deny' : required ? 'allow' : matching.some((grant) => grant.mode === 'deny') ? 'deny' : matching.some((grant) => grant.mode === 'allow') ? 'allow' : '';
      const row = document.createElement('div');
      row.className = 'cap-row';
      const name = document.createElement('div');
      name.className = 'cap-name';
      const kind = document.createElement('span');
      kind.className = 'cap-kind';
      kind.textContent = capability.kind;
      const code = document.createElement('code');
      code.textContent = capability.id;
      name.append(kind, code);
      const select = document.createElement('select');
      select.dataset.capKind = capability.kind;
      select.dataset.capId = capability.id;
      select.dataset.mode = mode;
      [['',t('unset')],['allow',t('allow')],['deny',t('deny')]].forEach(([value,label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        option.selected = value === mode;
        select.append(option);
      });
      select.dataset.nativeFixed = String(Boolean(required || forbidden));
      select.disabled = isEditingLocked() || required || forbidden;
      if (required || forbidden) row.title = state.locale === 'ru-RU' ? 'Штатное ограничение роли; права не повышаются' : 'Fixed native role restriction; grants cannot elevate rights';
      select.addEventListener('change', () => updateCapability(agent.id, capability.kind, capability.id, select.value));
      row.append(name, select);
      els.capabilityList.append(row);
    }
  }

  function updateCapability(agentId, kind, id, mode) {
    if (isEditingLocked()) return lockedToast();
    const agent = getAgent(agentId);
    agent.capabilities.grants = agent.capabilities.grants.filter((grant) => !(grant.kind === kind && grant.id === id));
    if (mode) agent.capabilities.grants.push({ kind, id, mode });
    markDefinitionDirty();
    renderInspector();
  }

  function updateSelectedAgent(field, value) {
    if (isEditingLocked()) return lockedToast();
    if (state.selection?.type !== 'node') return;
    const agent = getAgent(state.selection.id);
    if (!agent) return;
    agent[field] = value;
    markDefinitionDirty();
    renderNodes();
    els.inspectorTitle.textContent = agent.displayName || agent.technicalName || 'AgentNode';
  }

  function updateModel(part, value) {
    if (isEditingLocked()) return lockedToast();
    const agent = state.selection?.type === 'node' ? getAgent(state.selection.id) : null;
    if (!agent) return;
    if (part === 'provider') {
      agent.model.provider = value;
      const firstModel = MODEL_CATALOG[value]?.[0];
      agent.model.model = firstModel?.id || '';
      agent.model.reasoningEffort = firstModel?.reasoningEfforts?.[0] || '';
    } else if (part === 'model') {
      agent.model.model = value;
      const selectedModel = (MODEL_CATALOG[agent.model.provider] || []).find((model) => model.id === value);
      agent.model.reasoningEffort = selectedModel?.reasoningEfforts?.[0] || '';
    } else {
      agent.model.reasoningEffort = value;
    }
    markDefinitionDirty();
    renderNodes();
    renderInspector();
  }

  function setEntryAgent(id, enabled = true) {
    if (isEditingLocked()) return lockedToast();
    if (getAgent(id)?.slot !== 'entry') { toast(t('entryFixed'), 'error'); return; }
    state.definition.entryAgentId = enabled ? id : null;
    markDefinitionDirty();
    renderNodes();
    renderInspector();
  }

  function validateDefinition() {
    const errors = [];
    const agents = state.definition.agents;
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    const entry = state.definition.entryAgentId;
    if (!entry) errors.push(issue('MISSING_ENTRY', t('errorMissingEntry'), 'team'));
    else if (!agentById.has(entry)) errors.push(issue('MISSING_ENTRY_NODE', t('errorEntryMissingNode'), 'team'));

    const names = new Map();
    for (const agent of agents) {
      const required = [
        ['technicalName', agent.technicalName, t('technicalNameLabel')],
        ['displayName', agent.displayName, t('displayNameLabel')],
        ['role', agent.role, t('roleLabel')],
        ['systemPrompt', agent.systemPrompt, t('systemPromptLabel')]
      ];
      required.forEach(([field,value,label]) => {
        if (!String(value || '').trim()) errors.push(issue('REQUIRED_FIELD', t('errorRequiredField', { field: label }), `node:${agent.id}:${field}`));
      });
      const technicalName = String(agent.technicalName || '').trim();
      if (technicalName) {
        if (names.has(technicalName)) errors.push(issue('DUPLICATE_TECHNICAL_NAME', t('errorDuplicateName', { name: technicalName }), `node:${agent.id}`));
        else names.set(technicalName, agent.id);
      }
      const models = MODEL_CATALOG[agent.model?.provider] || [];
      const model = models.find((item) => item.id === agent.model?.model);
      if (!model) {
        errors.push(issue('INVALID_MODEL', t('errorInvalidModel', { provider: agent.model?.provider || '—', model: agent.model?.model || '—' }), `node:${agent.id}:model`));
      } else if (agent.model?.reasoningEffort && model.reasoningEfforts?.length && !model.reasoningEfforts.includes(agent.model.reasoningEffort)) {
        errors.push(issue('INVALID_REASONING', t('errorInvalidReasoning', { value: agent.model.reasoningEffort, provider: agent.model.provider, model: agent.model.model }), `node:${agent.id}:reasoning`));
      }
      for (const grant of agent.capabilities?.grants || []) {
        const valid = CAPABILITY_CATALOG.some((cap) => cap.kind === grant.kind && cap.id === grant.id);
        if (!valid) errors.push(issue('INVALID_CAPABILITY', t('errorInvalidCapability', { kind: grant.kind, id: grant.id }), `node:${agent.id}:capability`));
      }
    }

    const incomingManagers = new Map();
    for (const edge of state.definition.authorityEdges) {
      if (!agentById.has(edge.from) || !agentById.has(edge.to)) errors.push(issue('DANGLING_AUTHORITY', t('errorDanglingEdge', { kind: 'Authority' }), `edge:${edge.id}`));
      if (edge.from === edge.to) errors.push(issue('AUTHORITY_SELF', t('errorAuthoritySelf'), `edge:${edge.id}`));
      if (agentById.has(edge.to)) {
        const count = (incomingManagers.get(edge.to) || 0) + 1;
        incomingManagers.set(edge.to, count);
        if (count > 1) errors.push(issue('MULTIPLE_MANAGERS', t('errorMultipleManagers', { name: agentById.get(edge.to).displayName || edge.to }), `node:${edge.to}`));
      }
    }
    for (const edge of state.definition.communicationEdges) {
      if (!agentById.has(edge.from) || !agentById.has(edge.to)) errors.push(issue('DANGLING_COMMUNICATION', t('errorDanglingEdge', { kind: 'Communication' }), `edge:${edge.id}`));
    }
    if (hasAuthorityCycle(agentById)) errors.push(issue('AUTHORITY_CYCLE', t('errorAuthorityCycle'), 'authority'));

    state.validation = { hasRun: true, errors };
    renderValidation();
    return errors;
  }

  function issue(code, message, target) { return { code, message, target, blocking: true }; }

  function hasAuthorityCycle(agentById) {
    const adjacency = new Map([...agentById.keys()].map((id) => [id, []]));
    state.definition.authorityEdges.forEach((edge) => {
      if (adjacency.has(edge.from) && adjacency.has(edge.to)) adjacency.get(edge.from).push(edge.to);
    });
    const visiting = new Set();
    const visited = new Set();
    function visit(id) {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const child of adjacency.get(id) || []) if (visit(child)) return true;
      visiting.delete(id);
      visited.add(id);
      return false;
    }
    return [...adjacency.keys()].some(visit);
  }

  function renderValidation() {
    els.validationList.replaceChildren();
    if (!state.validation.hasRun) {
      els.validateButton.dataset.validation = 'none';
      els.validateButtonStatus.textContent = '';
      els.validationBadge.textContent = '—';
      els.validationBadge.className = 'badge neutral';
      els.validationSummary.textContent = t('notValidated');
      const empty = document.createElement('div');
      empty.className = 'validation-empty';
      empty.textContent = t('validationPrompt');
      els.validationList.append(empty);
      return;
    }
    const errors = state.validation.errors;
    if (!errors.length) {
      els.validateButton.dataset.validation = 'pass';
      els.validateButtonStatus.textContent = 'PASS';
      els.validationBadge.textContent = 'PASS';
      els.validationBadge.className = 'badge success';
      els.validationSummary.textContent = t('validated');
      const ok = document.createElement('div');
      ok.className = 'validation-ok';
      ok.textContent = t('noValidationIssues');
      els.validationList.append(ok);
      return;
    }
    els.validateButton.dataset.validation = 'failed';
    els.validateButtonStatus.textContent = `FAILED · ${errors.length}`;
    els.validationBadge.textContent = 'FAILED';
    els.validationBadge.className = 'badge error';
    setStatusDockCollapsed(false, { mark: false });
    els.validationSummary.textContent = t('validationFailed', { count: errors.length });
    for (const error of errors) {
      const row = document.createElement('div');
      row.className = 'validation-item';
      const icon = document.createElement('span');
      icon.className = 'validation-icon';
      const message = document.createElement('span');
      message.textContent = error.message;
      const target = document.createElement('span');
      target.className = 'validation-target';
      target.textContent = error.target;
      row.append(icon, message, target);
      row.addEventListener('click', () => focusValidationTarget(error.target));
      els.validationList.append(row);
    }
  }

  function focusValidationTarget(target) {
    if (target.startsWith('node:')) {
      const id = target.split(':')[1];
      if (getAgent(id)) {
        state.selection = { type: 'node', id };
        setInspectorCollapsed(false, { mark: false });
        renderSelection();
      }
    } else if (target.startsWith('edge:')) {
      const id = target.split(':')[1];
      const kind = state.definition.authorityEdges.some((edge) => edge.id === id) ? 'authority' : 'communication';
      state.selection = { type: 'edge', id, kind };
      setInspectorCollapsed(false, { mark: false });
      renderSelection();
    }
  }

  function resetRuntime() {
    state.runtime = { status: 'STOPPED', id: null, bindings: {} };
  }

  async function validateOnHost() {
    const local = validateDefinition();
    if (local.length) return local;
    try {
      const errors = await bridge.call('teams/validate', { definition: state.definition });
      state.validation = { hasRun: true, errors: errors.map(e => ({ ...e, target: e.target || '' })) };
      renderValidation();
      return errors;
    } catch (e) {
      const errors = [{ code: 'HOST_VALIDATION_UNAVAILABLE', message: String(e.message || e), target: 'team' }];
      state.validation = { hasRun: true, errors };
      renderValidation();
      return errors;
    }
  }

  async function syncRun() {
    if (state.runtime.status === 'STARTING') return;
    const id = bridge.sessionId();
    if (!id) return;
    const run = await bridge.call('runs/for-session', { sessionId: id });
    if (!run || run.teamDefinitionId !== state.definition.id) {
      if (state.runtime.status !== 'STOPPED') { resetRuntime(); renderAll(); }
      return;
    }
    const prior = state.runtime;
    const statusChanged = prior.id !== run.id || prior.status !== run.status;
    const bindingsChanged = JSON.stringify(prior.bindings) !== JSON.stringify(run.bindings);
    state.runtime = { id: run.id, status: run.status, bindings: run.bindings };
    if (statusChanged) renderRuntime();
    if (statusChanged || bindingsChanged) {
      for (const node of els.nodeLayer.children) {
        const status = state.runtime.bindings[node.dataset.id]?.status || (run.status === 'STOPPED' ? 'NOT_STARTED' : 'IDLE');
        node.dataset.runtime = status;
        const label = node.querySelector('.runtime-chip span:last-child');
        if (label) label.textContent = status;
      }
      if (state.selection?.type === 'node') {
        const binding = state.runtime.bindings[state.selection.id];
        const status = binding?.status || (run.status === 'STOPPED' ? 'NOT_STARTED' : 'IDLE');
        els.inspectorRuntimeStatus.textContent = status;
        els.inspectorStatusDot.style.background = status === 'RUNNING' ? 'var(--success)' : status === 'PAUSED' ? 'var(--warning)' : status === 'ERROR' ? 'var(--danger)' : '#657184';
        els.openChatButton.disabled = !binding?.sessionId;
      }
    }
    const items = await bridge.call('runs/activity', { id: run.id });
    const activity = $('nodesActivity');
    activity.replaceChildren();
    for (const row of [...(items.tasks || []), ...(items.messages || [])].slice(-12)) {
      const el = document.createElement('div');
      el.textContent = row.goal ? 'Task: ' + row.goal + ' (' + row.status + ')' :
        'Message: ' + (row.text || '').slice(0, 120) + ' (' + row.state + ')';
      activity.append(el);
    }
  }

  async function startRuntime() {
    if (!['STOPPED','FAILED'].includes(state.runtime.status)) return false;
    if ((await validateOnHost()).length) { toast(t('startBlocked'), 'error'); return false; }
    if ((state.dirty.definition || state.dirty.layout) && !await saveTeam({ silent: true })) return false;
    const sessionId = bridge.sessionId();
    if (!sessionId) { toast(t('chooseChat'), 'error'); return false; }
    state.runtime = { status: 'STARTING', id: null, bindings: {} };
    renderAll();
    try {
      const run = await bridge.startTeam(state.definition.id, sessionId);
      state.runtime = { status: run.status, id: run.id, bindings: run.bindings };
      renderAll();
      toast(t('running'), 'success');
      return true;
    } catch (e) {
      resetRuntime(); renderAll(); toast(String(e.message || e), 'error');
      return false;
    }
  }

  async function controlRuntime(action) {
    if (!state.runtime.id) return false;
    try {
      const run = await bridge.call('runs/control', { id: state.runtime.id, action });
      state.runtime = { id: run.id, status: run.status, bindings: run.bindings };
      renderAll();
      toast(t(action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'stopped'));
      return true;
    } catch (e) { toast(String(e.message || e), 'error'); return false; }
  }
  const pauseRuntime = () => controlRuntime('pause');
  const resumeRuntime = () => controlRuntime('resume');
  const stopRuntime = () => controlRuntime('stop');

  function renderRuntime() {
    const status = state.runtime.status;
    els.runStateLabel.textContent = status;
    els.runPill.dataset.state = status;
    els.runIdLabel.textContent = state.runtime.id || '—';
    els.startButton.hidden = !['STOPPED','FAILED'].includes(status);
    els.pauseButton.hidden = status !== 'RUNNING';
    els.resumeButton.hidden = status !== 'PAUSED';
    els.stopButton.hidden = !['STARTING','RUNNING','PAUSED','FAILED'].includes(status);
    if (status === 'RUNNING') els.runtimeCopy.textContent = t('runtimeRunningHelp');
    else if (status === 'PAUSED') els.runtimeCopy.textContent = t('runtimePausedHelp');
    else if (status === 'STARTING') els.runtimeCopy.textContent = t('runtimeStartingHelp');
    else els.runtimeCopy.textContent = t('runtimeStoppedHelp');
    if (status === 'FAILED') setStatusDockCollapsed(false, { mark: false });
    renderInspector();
  }

  function lockedToast() { toast(t('editLocked'), 'error'); }

  function toast(message, kind = '') {
    const item = document.createElement('div');
    item.className = `toast ${kind}`.trim();
    item.textContent = message;
    els.toastStack.append(item);
    setTimeout(() => item.remove(), 2800);
  }

  function applyViewport() {
    const { x, y, zoom } = state.layout.viewport;
    const dpr = window.devicePixelRatio || 1;
    const pixelX = Math.round(x * dpr) / dpr;
    const pixelY = Math.round(y * dpr) / dpr;
    els.canvasStage.style.transform = `translate3d(${pixelX}px, ${pixelY}px, 0)`;
    els.canvasWorld.style.zoom = String(zoom);
    els.zoomReadout.textContent = `${Math.round(zoom * 100)}%`;
    const grid = gridSize() * zoom;
    if (!state.layout.visual.gridVisible) {
      els.canvasShell.style.backgroundImage = 'none';
      return;
    }
    if (state.layout.visual.gridStyle === 'lines') {
      els.canvasShell.style.backgroundImage = 'linear-gradient(rgba(114,133,164,.14) 1px, transparent 1px), linear-gradient(90deg, rgba(114,133,164,.14) 1px, transparent 1px)';
    } else {
      els.canvasShell.style.backgroundImage = 'radial-gradient(circle at 1px 1px, rgba(114,133,164,.28) 1px, transparent 1.1px)';
    }
    els.canvasShell.style.backgroundSize = `${grid}px ${grid}px`;
    els.canvasShell.style.backgroundPosition = `${x % grid}px ${y % grid}px`;
  }

  function setZoom(nextZoom, clientX = els.canvasShell.clientWidth / 2, clientY = els.canvasShell.clientHeight / 2) {
    const rect = els.canvasShell.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const view = state.layout.viewport;
    const worldX = (localX - view.x) / view.zoom;
    const worldY = (localY - view.y) / view.zoom;
    const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    view.x = localX - worldX * zoom;
    view.y = localY - worldY * zoom;
    view.zoom = zoom;
    applyViewport();
    markLayoutDirty();
  }

  function fitView() {
    if (!state.definition.agents.length) {
      state.layout.viewport = { x: 120, y: 80, zoom: 1 };
      applyViewport();
      markLayoutDirty();
      return;
    }
    const positions = state.definition.agents.map((agent) => state.layout.nodes[agent.id]).filter(Boolean);
    const minX = Math.min(...positions.map((pos) => pos.x));
    const minY = Math.min(...positions.map((pos) => pos.y));
    const maxX = Math.max(...positions.map((pos) => pos.x + NODE_WIDTH));
    const maxY = Math.max(...positions.map((pos) => pos.y + NODE_HEIGHT));
    const width = maxX - minX + 120;
    const height = maxY - minY + 120;
    const computedZoom = Math.min(els.canvasShell.clientWidth / width, els.canvasShell.clientHeight / height);
    const zoom = clamp(computedZoom, MIN_ZOOM, 1.18);
    state.layout.viewport.zoom = zoom;
    state.layout.viewport.x = (els.canvasShell.clientWidth - (maxX - minX) * zoom) / 2 - minX * zoom;
    state.layout.viewport.y = (els.canvasShell.clientHeight - (maxY - minY) * zoom) / 2 - minY * zoom;
    applyViewport();
    markLayoutDirty();
  }

  function onCanvasPointerDown(event) {
    if (event.button !== 0 || event.target.closest('.agent-node') || event.target.closest('.edge-hit')) return;
    if (state.edgeMode !== 'select') {
      state.edgeSourceId = null;
      updateConnectionBanner();
      renderNodes();
      return;
    }
    state.selection = null;
    renderSelection();
    state.interaction.pan = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: state.layout.viewport.x,
      startY: state.layout.viewport.y,
      moved: false
    };
    els.canvasShell.classList.add('is-panning');
    els.canvasShell.setPointerCapture(event.pointerId);
  }

  function onCanvasPointerMove(event) {
    const pan = state.interaction.pan;
    if (!pan) return;
    const dx = event.clientX - pan.startClientX;
    const dy = event.clientY - pan.startClientY;
    if (Math.abs(dx) + Math.abs(dy) > 2) pan.moved = true;
    state.layout.viewport.x = pan.startX + dx;
    state.layout.viewport.y = pan.startY + dy;
    applyViewport();
  }

  function onCanvasPointerUp() {
    if (!state.interaction.pan) return;
    const moved = state.interaction.pan.moved;
    state.interaction.pan = null;
    els.canvasShell.classList.remove('is-panning');
    if (moved) markLayoutDirty();
  }

  function bindEvents() {
    root.querySelectorAll('[data-locale-action]').forEach((button) => button.addEventListener('click', () => setLocale(button.dataset.localeAction)));
    root.querySelectorAll('[data-edge-mode]').forEach((button) => button.addEventListener('click', () => setEdgeMode(button.dataset.edgeMode)));
    root.querySelectorAll('[data-communication-direction]').forEach((button) => button.addEventListener('click', () => setCommunicationDirection(button.dataset.communicationDirection)));
    els.addNodeButton.addEventListener('click', () => createAgent());
    els.emptyAddButton.addEventListener('click', () => createAgent());
    els.loadDemoButton.addEventListener('click', () => loadDemo());
    els.resetButton.addEventListener('click', () => resetPrototype());
    els.saveButton.addEventListener('click', () => { void saveTeam(); });
    $('saveAsButton').addEventListener('click', () => { void saveAsTeam(); });
    els.validateButton.addEventListener('click', () => { void validateOnHost(); });
    els.startButton.addEventListener('click', () => startRuntime());
    els.pauseButton.addEventListener('click', () => pauseRuntime());
    els.resumeButton.addEventListener('click', () => resumeRuntime());
    els.stopButton.addEventListener('click', () => stopRuntime());
    els.deleteSelectionButton.addEventListener('click', deleteSelection);
    els.deleteEdgeButton.addEventListener('click', deleteSelection);
    els.openChatButton.addEventListener('click', () => {
      const binding = state.selection?.type === 'node' && state.runtime.bindings[state.selection.id];
      if (!binding?.sessionId) return;
      try { bridge.openChat(binding); } catch (e) { toast(String(e.message || e), 'error'); }
    });
    els.teamName.addEventListener('input', () => { state.definition.name = els.teamName.value; markDefinitionDirty(); });
    els.technicalNameInput.addEventListener('input', () => updateSelectedAgent('technicalName', els.technicalNameInput.value));
    els.displayNameInput.addEventListener('input', () => updateSelectedAgent('displayName', els.displayNameInput.value));
    els.roleInput.addEventListener('input', () => updateSelectedAgent('role', els.roleInput.value));
    els.systemPromptInput.addEventListener('input', () => updateSelectedAgent('systemPrompt', els.systemPromptInput.value));
    els.providerSelect.addEventListener('change', () => updateModel('provider', els.providerSelect.value));
    els.modelSelect.addEventListener('change', () => updateModel('model', els.modelSelect.value));
    els.reasoningSelect.addEventListener('change', () => updateModel('reasoningEffort', els.reasoningSelect.value));
    els.makeEntryButton.addEventListener('click', () => { if (state.selection?.type === 'node') setEntryAgent(state.selection.id, true); });
    els.inspectorCollapseButton.addEventListener('click', () => setInspectorCollapsed(!state.ui.inspectorCollapsed));
    els.canvasSettingsButton.addEventListener('click', (event) => { event.stopPropagation(); setCanvasSettingsOpen(els.canvasSettingsPopover.hidden); });
    els.canvasSettingsPopover.addEventListener('click', (event) => event.stopPropagation());
    els.gridVisibleInput.addEventListener('change', () => setLayoutVisual('gridVisible', els.gridVisibleInput.checked, { rerenderGrid: true }));
    els.gridStyleSelect.addEventListener('change', () => setLayoutVisual('gridStyle', els.gridStyleSelect.value, { rerenderGrid: true }));
    els.gridSizeSelect.addEventListener('change', () => setLayoutVisual('gridSize', Number(els.gridSizeSelect.value), { rerenderGrid: true, rerenderEdges: true }));
    els.snapNodesInput.addEventListener('change', () => setLayoutVisual('snapNodes', els.snapNodesInput.checked));
    els.alignNodesButton.addEventListener('click', alignNodesToGrid);
    root.querySelectorAll('[data-routing-mode]').forEach((button) => button.addEventListener('click', () => setLayoutVisual('edgeRouting', button.dataset.routingMode, { rerenderEdges: true })));
    document.addEventListener('pointerdown', (event) => { if (!els.canvasSettingsPopover.hidden && !event.target.closest('.canvas-settings-wrap')) setCanvasSettingsOpen(false); }, { signal: globalEvents.signal });
    els.zoomOutButton.addEventListener('click', () => setZoom(state.layout.viewport.zoom / 1.15));
    els.zoomInButton.addEventListener('click', () => setZoom(state.layout.viewport.zoom * 1.15));
    els.fitButton.addEventListener('click', fitView);
    els.canvasShell.addEventListener('wheel', (event) => {
      event.preventDefault();
      setZoom(state.layout.viewport.zoom * (event.deltaY > 0 ? 0.9 : 1.1), event.clientX, event.clientY);
    }, { passive: false });
    els.canvasShell.addEventListener('pointerdown', onCanvasPointerDown);
    els.canvasShell.addEventListener('pointermove', onCanvasPointerMove);
    els.canvasShell.addEventListener('pointerup', onCanvasPointerUp);
    els.canvasShell.addEventListener('pointercancel', onCanvasPointerUp);
    els.dockToggle.addEventListener('click', () => setStatusDockCollapsed(!state.ui.statusDockCollapsed));
    document.addEventListener('keydown', (event) => {
      if (!root.contains(event.target)) return;
      const target = event.target;
      const typing = target && ['INPUT','TEXTAREA','SELECT'].includes(target.tagName);
      if (!typing && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        deleteSelection();
      }
      if (!typing && event.key === 'Escape') {
        setCanvasSettingsOpen(false);
        state.edgeSourceId = null;
        updateConnectionBanner();
        setEdgeMode('select');
      }
    }, { signal: globalEvents.signal });
    window.addEventListener('resize', onResize, { signal: globalEvents.signal });
  }

  const globalEvents = new AbortController();
  const onResize = () => renderEdges();
  loadInitialState();
  bindEvents();
  setCommunicationDirection('bidirectional');
  setEdgeMode('select');
  renderAll();
  applyI18n();
  void initializeFromHost();
  const poll = setInterval(() => { if (state.persisted) void syncRun().catch(() => {}); }, 2500);
  return () => { clearInterval(poll); globalEvents.abort(); };

}


const React = require('react');
const CHANNEL = '/nodes-agent-by-andrew';
function apply(ctx) {
  const connection = ctx.get('connection');
  const sessions = ctx.get('sessions');
  const call = async (endpoint, data = {}, signal) => {
    const response = await connection.rpc.call(CHANNEL, endpoint, { sessionId: sessions.list.getSnapshot().current, ...data }, signal);
    if (!response?.ok) throw Error((response?.error?.code || 'NODES_AGENT_ERROR') +
      ': ' + (response?.error?.message || 'Unavailable'));
    return response.value;
  };
  const startTeam = async (teamId, sessionId) => {
    const summary = sessions.list.getSnapshot().byId[sessionId];
    if (summary?.blank === true) {
      const response = await connection.api.agentPresets.select({ sessionId, agentPreset: 'postman-leader-ptc-nodes' });
      if (!response.result.ok) throw Error(response.result.error.message);
      sessions.noteAgentPreset(sessionId, response.result.value.agentPreset);
    } else if (summary?.agentPreset !== 'postman-leader-ptc-nodes') {
      throw Error('A blank new Chat is required to select the Nodes preset');
    }
    return call('runs/start', { teamId, sessionId });
  };
  const bridge = {
    call, startTeam,
    sessionId: () => sessions.list.getSnapshot().current,
    openChat(binding) {
      if (!binding?.sessionId) throw Error('AgentNode has no DSH Session');
      if (binding.parentSessionId) {
        if (typeof sessions.openSubagent !== 'function') throw Error('Native subagent navigation is unavailable');
        sessions.openSubagent({ parentSessionId: binding.parentSessionId,
          childSessionId: binding.sessionId });
      } else {
        if (typeof sessions.open !== 'function') throw Error('Native session navigation is unavailable');
        sessions.open(binding.sessionId);
      }
    }
  };
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.nodesAgentByAndrew = 'true';
    style.textContent = EDITOR_CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'nodes-agent: style');
  let editorWindow = null;
  function openEditorWindow() {
    if (editorWindow && !editorWindow.closed) {
      editorWindow.focus();
      return;
    }
    const popup = window.open('', 'nodes-agent-by-andrew-editor', 'popup,width=1480,height=920');
    if (!popup) throw Error('Allow pop-up windows to open the NodesAgent editor');
    try {
      const doc = popup.document;
      doc.open();
      doc.write('<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>NodesAgent_by_Andrew</title>' +
        '<style>html,body{width:100%;height:100%;margin:0;background:#0b0e14}' +
        EDITOR_CSS + '</style></head><body><div class="nodes-agent-root" id="nodesAgentWindowRoot">' +
        EDITOR_HTML + '</div></body></html>');
      doc.close();
      const dispose = mountEditor(doc.getElementById('nodesAgentWindowRoot'), bridge);
      editorWindow = popup;
      popup.addEventListener('pagehide', () => {
        dispose?.();
        if (editorWindow === popup) editorWindow = null;
      }, { once: true });
      popup.focus();
    } catch (error) {
      popup.close();
      throw error;
    }
  }
  function TeamChoice({ session }) {
    const sessionId = session?.id || bridge.sessionId();
    const [list, setList] = React.useState([]);
    const [selection, setSelection] = React.useState('');
    const [visible, setVisible] = React.useState(false);
    const [pending, setPending] = React.useState(false);
    const [error, setError] = React.useState('');
    React.useEffect(() => {
      let active = true;
      call('teams/list').then(rows => {
        if (!active) return;
        setList(rows);
        setSelection(current => rows.some(row => row.id === current) ? current : rows[0]?.id || '');
      }).catch(e => { if (active) setError(String(e.message || e)); });
      return () => { active = false; };
    }, [visible]);
    const ru = navigator.language.toLowerCase().startsWith('ru');
    const create = async () => {
      if (!selection || !sessionId || pending) return;
      setPending(true); setError('');
      try {
        await startTeam(selection, sessionId);
        setVisible(false);
      } catch (e) { setError(String(e.message || e)); }
      finally { setPending(false); }
    };
    return React.createElement('div', { className: 'nodes-team-choice' },
      React.createElement('button', { type: 'button', onClick: () => setVisible(!visible),
        'aria-expanded': visible }, ru ? 'Команда агентов' : 'Use Agent Team'),
      visible && React.createElement('div', { className: 'nodes-team-choice-panel' },
        React.createElement('label', null, ru ? 'Сохранённая команда' : 'Saved team',
          React.createElement('select', { value: selection, onChange: e => setSelection(e.target.value) },
            ...list.map(row => React.createElement('option', { key: row.id, value: row.id }, row.name)))),
        React.createElement('button', { type: 'button', disabled: pending || !selection || !sessionId, onClick: create },
          pending ? '…' : (ru ? 'Запустить' : 'Start')),
        React.createElement('button', { type:'button', onClick: () => {
          try { openEditorWindow(); } catch (e) { setError(String(e.message || e)); }
        } }, ru ? 'Редактор команды' : 'Edit team'),
        error && React.createElement('small', { role: 'alert' }, error)));
  }
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'nodes-agent-use-team', order: 81,
    inject: () => ({})
  }, TeamChoice));
}
module.exports = { apply, inject: ['slots', 'sessions', 'connection'], CHANNEL };

 return module.exports;
 }
});
