"""Real Chromium DOM: banners, re-proof, natural Send and result correlation."""
import html
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from playwright.sync_api import Locator, sync_playwright

WEB = Path(__file__).resolve().parents[1]
if str(WEB) not in sys.path:
    sys.path.insert(0, str(WEB))
import artifact_detector as artifact
import artifact_download
import browser_observer as observer
import browser_recovery as recovery
import browser_submit as submit
import reminder_policy as reminders
import system_recovery
import transport_control as transport
import web_worker_bridge as bridge_module

REQ = "REQ_20261001T041338Z_9561"
URL = "https://chatgpt.com/c/recovery-fixture"
PROMPT = f"POSTMAN_REQUEST_ID: {REQ}\ntask_file: https://example.test/task.md"
FILENAME = f"POSTMAN_{REQ}_RESULT.zip"
ACTIVITY = '<div data-chatgpt-agent-turn-start><div data-testid="activity-progress">Thinking</div></div>'
COMPOSER = '<div id="prompt-textarea" class="ProseMirror" role="textbox" contenteditable="true" style="width:300px;height:50px"></div>'


def group(prompt=PROMPT, body=ACTIVITY, key="original"):
    return f'<div data-turn-key="{key}"><div data-user-message-bubble="true">{html.escape(prompt)}</div>{body}</div>'


def final(body):
    return ('<div data-content-search-unit-key="unit:assistant" data-conversation-role="assistant" '
            'data-chatgpt-selection-message-id="final"><div data-markdown-text-style="assistant-message">'
            + body + '</div></div><button data-testid="copy-turn-action-button">Copy</button>')


def document(turns=None, banner="", stop=False):
    return '<main>' + (turns if turns is not None else group(body=ACTIVITY + banner)) + '</main>' + COMPOSER + (
        '<button data-testid="stop-button" onclick="window.stopClicks=(window.stopClicks||0)+1;this.remove()">Stop</button>' if stop else '') + '''
        <button data-testid="send-button" aria-label="Send" onclick="
        const text=document.querySelector('#prompt-textarea').innerText;
        const group=document.createElement('div');group.setAttribute('data-turn-key','sent-'+document.querySelectorAll('[data-user-message-bubble]').length);
        const bubble=document.createElement('div');bubble.setAttribute('data-user-message-bubble','true');bubble.textContent=text;group.append(bubble);
        document.querySelector('main').append(group);document.querySelector('#prompt-textarea').innerHTML='';window.sends=(window.sends||0)+1;">Send</button>'''


class Clock:
    def __init__(self):
        self.value = 0.0
    def now(self):
        return self.value
    def sleep(self, seconds):
        self.value += seconds


class TransportDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
    def setUp(self):
        self.page = self.browser.new_page()
        self.route_body = document()
        self.page.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html; charset=utf-8', body=self.route_body))
        self.page.goto(URL)
        self.clock = Clock()
    def tearDown(self):
        if not self.page.is_closed():
            self.page.close()
    def set_html(self, text):
        self.page.set_content(text)

    def test_connection_headline_without_subtitle_inside_modern_turn(self):
        for headline in ('Соединение прервано', 'CONNECTION  interrupted!', 'Connection interrupted. Новый подзаголовок'):
            with self.subTest(headline=headline):
                self.set_html(document(banner='<div><h3>' + headline + '</h3></div>'))
                accepted, evidence = observer.connection_interrupted(self.page)
                self.assertTrue(accepted, evidence)
                self.assertTrue(evidence['evidence']['insideTurnWrapper'])
                self.assertFalse(evidence['evidence']['insideMarkdown'])
    def test_connection_semantic_alert_status_live_and_retry(self):
        for attrs in ('role="alert"', 'role="status"', 'aria-live="polite"', 'data-testid="connection-error"'):
            self.set_html(document(banner=f'<section {attrs}><h3>Соединение прервано</h3><div>Попробуем подключиться снова</div></section>'))
            accepted, details = observer.connection_interrupted(self.page)
            self.assertTrue(accepted, details)
            self.assertTrue(details['evidence']['systemContainer'])
        self.set_html(document(banner='<section><h3>Connection interrupted</h3><button>Reconnect</button></section>'))
        self.assertTrue(observer.connection_interrupted(self.page)[1]['evidence']['retryControlNearby'])
    def test_literal_markdown_quotes_are_rejected_with_reason(self):
        for text in ('Соединение прервано', 'Our systems are performing additional processing'):
            self.set_html(document(turns=group(body=final('<blockquote>' + text + '</blockquote>'))))
            detector = observer.connection_interrupted if text.startswith('Соединение') else observer.additional_processing
            accepted, evidence = detector(self.page)
            self.assertFalse(accepted, evidence)
            self.assertEqual(evidence['reason'], 'transcript_or_literal_quote')
    def test_hidden_banner_is_not_candidate(self):
        self.set_html(document(banner='<div role="status" style="display:none">Connection interrupted</div>'))
        self.assertEqual(observer.connection_interrupted(self.page)[1]['candidateCount'], 0)
    def test_additional_processing_wording_and_relationships(self):
        variants = ('Наши системы выполняют дополнительную обработку этого запроса…',
                    'Наши системы сейчас обрабатывают запрос', 'Дополнительная обработка запроса…',
                    'Our systems are doing additional processing...', 'Our systems are currently processing this request',
                    'Additional processing is required')
        for text in variants:
            self.set_html(document(banner='<div role="status"><h3>' + text + '</h3><p>Пожалуйста, подождите</p></div>'))
            accepted, evidence = observer.additional_processing(self.page)
            self.assertTrue(accepted, evidence)
            self.assertTrue(evidence['evidence']['insideTurnWrapper'])
    def test_weak_local_signal_confirms_on_second_poll(self):
        self.set_html(document(banner='<div>Connection interrupted. ' + 'Waiting for response. ' * 12 + '</div>'))
        accepted, details = observer.connection_interrupted(self.page)
        self.assertFalse(accepted, details)
        self.assertEqual(details['confidence'], 'weak')
        control = transport.TransportControl(REQ, URL, 0, 3600000, 600000, 5, monotonic=self.clock.now)
        self.assertIsNone(control.candidate(observer.ASSISTANT_CONNECTION_INTERRUPTED, accepted, details))
        self.clock.sleep(2)
        self.assertIsNotNone(control.candidate(observer.ASSISTANT_CONNECTION_INTERRUPTED, accepted, details))
        self.assertTrue(control.journal[-1]['confirmedOnSecondPoll'])
    def test_weak_connection_survives_reload_and_blocks_ready_until_absent(self):
        banner = '<div>Connection interrupted. ' + 'Waiting for response. ' * 12 + '</div>'
        self.route_body = document(banner=banner)
        self.set_html(self.route_body)
        control = transport.TransportControl(REQ, URL, 0, 60000, 20000, 1, monotonic=self.clock.now)
        accepted, evidence = observer.connection_interrupted(self.page)
        self.assertFalse(accepted)
        self.assertEqual(evidence['confidence'], 'weak')
        self.assertIsNone(control.candidate(observer.ASSISTANT_CONNECTION_INTERRUPTED, accepted, evidence))
        self.clock.sleep(1)
        accepted, evidence = observer.connection_interrupted(self.page)
        event = control.candidate(observer.ASSISTANT_CONNECTION_INTERRUPTED, accepted, evidence)
        self.assertTrue(control.begin_recovery(observer.ASSISTANT_CONNECTION_INTERRUPTED, event))
        with patch.object(self.page, 'reload', wraps=self.page.reload) as reload:
            result = recovery.recover_interrupted_chat(self.page, URL, PROMPT,
                load_timeout_ms=2000, settle_ms=0, poll_ms=1000, max_attempts=1,
                budget_ms=10000, sleep=self.clock.sleep, monotonic=self.clock.now)
        self.assertEqual(reload.call_count, 1)
        self.assertFalse(result['ok'], result)
        after_reload = recovery.chat_ready_snapshot(self.page, URL, PROMPT)
        self.assertFalse(after_reload['ok'], after_reload)
        self.assertFalse(after_reload['details']['connectionInterrupted'])
        self.assertTrue(after_reload['details']['interruptionEvidencePresent'])
        self.assertEqual(after_reload['details']['interruption']['confidence'], 'weak')
        proofs = []
        def sleep(seconds):
            proofs.append(recovery.chat_ready_snapshot(self.page, URL, PROMPT)['ok'])
            self.clock.sleep(seconds)
            self.page.locator('main').evaluate('(el, body)=>el.innerHTML=body', group())
        ready = recovery.wait_for_chat_ready(self.page, URL, PROMPT, timeout_ms=2000,
            settle_ms=0, poll_ms=1000, sleep=sleep, monotonic=self.clock.now)
        self.assertEqual(proofs, [False])
        self.assertTrue(ready['ok'], ready)
        self.assertFalse(ready['details']['interruptionEvidencePresent'])

    def test_connection_reloads_owned_page_and_proves_original_task(self):
        self.set_html(document(banner='<div role="alert">Соединение прервано</div>'))
        events = []
        result = recovery.recover_interrupted_chat(self.page, URL, PROMPT, budget_ms=45000,
            sleep=self.clock.sleep, monotonic=self.clock.now, on_event=lambda name, **_: events.append(name))
        self.assertTrue(result['ok'], result)
        self.assertEqual(self.page.url, URL)
        self.assertEqual(self.clock.value, 10)
        self.assertIn('SAME_CHAT_CONFIRMED', events)
        self.assertIsNone(self.page.evaluate('window.sends'))
    def test_reproof_fails_on_missing_lineage_foreign_user_or_wrong_chat(self):
        for turns in (group(prompt='other'), group() + group(prompt='foreign', key='foreign')):
            self.set_html(document(turns=turns))
            proof = recovery.chat_ready_snapshot(self.page, URL, PROMPT)
            self.assertFalse(proof['ok'], proof)
        self.set_html(document())
        proof = recovery.chat_ready_snapshot(self.page, URL + '-other', PROMPT)
        self.assertFalse(proof['ok'])
    def test_additional_stop_reload_reproof_wait_without_sending(self):
        self.set_html(document(banner='<section role="status">Наши системы обрабатывают запрос</section>', stop=True))
        events = []
        result = system_recovery.prepare_additional_processing(self.page, URL, PROMPT, PROMPT,
            deadline=45, sleep=self.clock.sleep, monotonic=self.clock.now, uniform=lambda a, b: 14.3,
            on_event=lambda name, **fields: events.append((name, fields)))
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['details']['stop']['clickCount'], 1)
        self.assertEqual(result['details']['waitSeconds'], 14.3)
        self.assertEqual(self.clock.value, 14.3)
        names = [e[0] for e in events]
        self.assertLess(names.index('STOP_CLICK'), names.index('RELOAD_STARTED'))
        self.assertLess(names.index('SAME_CHAT_CONFIRMED'), names.index('SYSTEM_WAIT'))
        self.assertIsNone(self.page.evaluate('window.sends'))
    def test_stop_absent_and_unknown_are_nonfatal_and_never_reclicked(self):
        events = []
        result = system_recovery.stop_once(self.page, timeout_ms=1000, on_event=lambda *a, **k: events.append((a, k)))
        self.assertEqual(result['outcome'], 'ABSENT')
        class Uncertain:
            first = None
            def __init__(self): self.first=self; self.clicks=0
            def count(self): return 1
            def is_visible(self): return True
            def is_enabled(self): return True
            def click(self, **kwargs): self.clicks+=1; raise RuntimeError('lost response')
        uncertain = Uncertain()
        with patch.object(self.page, 'locator', return_value=uncertain):
            result = system_recovery.stop_once(self.page, timeout_ms=1000, on_event=lambda *a, **k: None)
        self.assertEqual(result['outcome'], 'UNKNOWN')
        self.assertEqual(uncertain.clicks, 1)
    def send_natural(self, *, slot=1, binding=None, anchor=PROMPT):
        intent = transport.make_intent(self.page, REQ, URL, PROMPT, anchor,
                                      slot=slot, anchor_binding=binding, randrange=lambda _: 7)
        self.assertEqual(intent['promptSha256'], submit.prompt_sha256(intent['exactPromptText']))
        result = reminders.submit_reminder(self.page, intent['exactPromptText'], URL,
            timeout_ms=1000, anchor_prompt=anchor, anchor_binding=binding,
            system_continuation=binding is not None, control_intent=intent, sleep=self.clock.sleep,
            monotonic=self.clock.now, uniform=lambda a,b: 0)
        self.assertTrue(result['ok'], result)
        binding = transport.confirmed_binding(self.page, intent, result)
        return intent, result, binding
    def test_exact_natural_send_and_repeated_template_are_distinct_turns(self):
        first, _, first_binding = self.send_natural()
        # Same random template again is allowed; correlation still selects the
        # exact intended ordinal, never the latest text match.
        second, _, second_binding = self.send_natural(slot=2, binding=first_binding, anchor=first['exactPromptText'])
        turns, _ = observer.snapshot_turns(self.page)
        self.assertEqual(first['exactPromptText'], second['exactPromptText'])
        self.assertEqual(observer.find_user_anchor(turns, first['exactPromptText'], anchor_binding=first_binding), 2)
        self.assertEqual(observer.find_user_anchor(turns, second['exactPromptText'], anchor_binding=second_binding), 3)
        self.assertNotEqual(first_binding['groupKey'], second_binding['groupKey'])
        self.assertEqual(self.page.evaluate('window.sends'), 2)
        self.assertFalse(recovery.chat_ready_snapshot(self.page, URL, first['exactPromptText'], original_prompt=PROMPT, anchor_binding=first_binding)['ok'])
    def test_send_proof_requires_exact_bound_chat(self):
        intent, result, binding = self.send_natural()
        self.assertFalse(submit._observe_send_proof(self.page, intent['exactPromptText'], 1, conversation_url=URL+'-wrong')[0])
        self.page.locator('[data-user-message-bubble]').first.evaluate('(el)=>el.textContent="foreign lineage"')
        with self.assertRaises(ValueError):
            transport.confirmed_binding(self.page, intent, result)
    def test_artifact_after_natural_control_preserves_req_and_exact_anchor(self):
        intent, sent, binding = self.send_natural()
        envelope = ('<p>' + html.escape(artifact.result_begin_marker(REQ)) + '</p>'
                    f'<a href="/fixture.zip" download="{FILENAME}">{FILENAME}</a>'
                    '<p>' + html.escape(artifact.result_end_marker(REQ)) + '</p>')
        self.page.locator('[data-turn-key]').last.evaluate('(el, body)=>el.insertAdjacentHTML("beforeend", body)', final(envelope))
        proof = observer.observe_next_assistant(self.page, intent['exactPromptText'], URL,
                                               anchor_binding=binding, timeout_ms=6000, stable_ms=0,
                                               sleep=self.clock.sleep, monotonic=self.clock.now)
        proof = bridge_module._attach_submit_proof(proof, prompt=intent['exactPromptText'], submitted=sent)
        proof['details'].update(controlIntent=intent, anchorBinding=binding)
        found = artifact.detect_artifact_dom(self.page, expected_prompt=intent['exactPromptText'],
            expected_chat_url=URL, request_id=REQ, expected_filename=FILENAME, completed_observer_result=proof)
        self.assertTrue(found['ok'], found)
        del proof['details']['controlIntent']
        rejected = artifact.detect_artifact_dom(self.page, expected_prompt=intent['exactPromptText'],
            expected_chat_url=URL, request_id=REQ, expected_filename=FILENAME, completed_observer_result=proof)
        self.assertFalse(rejected['ok'])

    def run_bridge(self, *, timeout_ms=60000, interval_ms=20000, count=1, sleep=None):
        page = self.page
        class Context:
            def new_page(self): return page
        class Chromium:
            def connect_over_cdp(self, _url):
                class Browser:
                    contexts = [Context()]
                return Browser()
        class Factory:
            def __enter__(self):
                class PW:
                    chromium = Chromium()
                return PW()
            def __exit__(self, *args): pass
        def submitted(*_args, **_kwargs):
            return {'ok': True, 'code': submit.PROMPT_SEND_CONFIRMED, 'sendState': submit.SEND_PROVEN_SENT,
                    'details': {'chatUrl': URL, 'userTurnCorrelationMode': 'exact'}}
        with tempfile.TemporaryDirectory() as root:
            bridge = bridge_module.WebWorkerBridge(root=root, sleep=sleep or self.clock.sleep,
                monotonic=self.clock.now, uniform=lambda a,b: a, randrange=lambda n: 7)
            with patch.object(submit, 'submit_fresh_prompt', side_effect=submitted) as initial_send:
                result = bridge.run_request(REQ, task_url='https://example.test/task.md', prompt=PROMPT,
                    expected_filename=FILENAME, expected_request={}, observer_timeout_ms=timeout_ms,
                    reminder_interval_ms=interval_ms, max_reminders=count, stable_ms=0,
                    playwright_factory=lambda: Factory())
            self.assertEqual(initial_send.call_count, 1)
            return result, bridge.read_state(REQ)

    def envelope(self):
        return ('<p>' + html.escape(artifact.result_begin_marker(REQ)) + '</p>'
                f'<a href="/fixture.zip" download="{FILENAME}">{FILENAME}</a>'
                '<p>' + html.escape(artifact.result_end_marker(REQ)) + '</p>')

    def route_result_after_send(self):
        answer = final(self.envelope())
        import json
        return document() + """<script>document.querySelector('[data-testid="send-button"]').addEventListener("click",()=>{document.querySelector('main [data-turn-key]:last-child').insertAdjacentHTML("beforeend",""" + json.dumps(answer) + ")});</script>"

    def test_production_bridge_stop_reload_wait_continue_exact_result(self):
        self.set_html(document(banner='<div role="status">Наши системы выполняют дополнительную обработку</div>', stop=True))
        self.route_body = self.route_result_after_send()
        with patch.object(artifact_download, 'download_validated_artifact', return_value={
                'ok':True, 'code':artifact_download.RESULT_DURABLE, 'details':{'resultDirectory':'fixture'}}):
            result, state = self.run_bridge()
        self.assertTrue(result['ok'], result)
        self.assertEqual(state['state'], bridge_module.RESULT_DURABLE)
        self.assertIsNone(state['activeFlow'])
        events = state['transportEventJournal']
        names = [e['event'] for e in events]
        for name in ('SYSTEM_CONFIRMED','STOP_CLICK','RELOAD_STARTED','SAME_CHAT_CONFIRMED','SYSTEM_WAIT',
                     'CONTINUATION_SELECTED','CONTROL_SEND_CONFIRMED','RESULT_TERMINAL'):
            self.assertIn(name, names)
        selected = next(e for e in events if e['event']=='CONTINUATION_SELECTED')
        self.assertIsNone(selected['slot'])
        self.assertIn('ADDITIONAL_PROCESSING', selected['recoveryEventId'])
        proof = next(e for e in events if e['event']=='CONTROL_SEND_CONFIRMED')['proof']
        self.assertTrue(proof['details']['exactUserTurn'])
        self.assertEqual(proof['details']['userTurnCountNow'],2)
        self.assertEqual(state['reminders'], [])
        self.assertEqual(state['reminderSlots'][0]['status'],'SUPPRESSED_FINAL')
        phases = [e['phase'] for e in events if e['event']=='STATE_TRANSITION']
        for phase in ('ADDITIONAL_PROCESSING','SYSTEM_STOP','SYSTEM_RELOAD','SYSTEM_CHAT_REPROOF','SYSTEM_WAIT','SYSTEM_CONTINUE'):
            self.assertIn(phase, phases)
    def test_bridge_connection_during_system_wait_hands_off_serially(self):
        self.set_html(document(banner='<div role="status">Additional processing</div>', stop=True))
        shown = [False]
        def sleep(seconds):
            self.clock.sleep(seconds)
            if seconds == 10 and not shown[0]:
                shown[0] = True
                self.set_html(document(banner='<div role="alert">Connection interrupted</div>'))
                self.route_body = document(turns=group(body=final(self.envelope())))
        with patch.object(self.page, 'reload', wraps=self.page.reload) as reload, patch.object(
                artifact_download, 'download_validated_artifact', return_value={
                    'ok': True, 'code': artifact_download.RESULT_DURABLE, 'details': {}}):
            result, state = self.run_bridge(interval_ms=5000, count=4, sleep=sleep)
        self.assertTrue(result['ok'], result)
        self.assertEqual(reload.call_count, 2)
        events = state['transportEventJournal']
        started = [e for e in events if e['event'] == 'RECOVERY_STARTED']
        self.assertEqual([e['kind'] for e in started],
                         [observer.ADDITIONAL_PROCESSING, observer.ASSISTANT_CONNECTION_INTERRUPTED])
        aborted = next(e for e in events if e['event'] == 'RECOVERY_ABORTED'
                       and e['eventId'] == started[0]['eventId'])
        self.assertEqual(aborted['reason'], 'serial_handoff')
        self.assertEqual(aborted['nextKind'], observer.ASSISTANT_CONNECTION_INTERRUPTED)
        self.assertLess(aborted['sequence'], started[1]['sequence'])
        self.assertNotIn('RECOVERY_FAILED', [e['event'] for e in events])
        self.assertNotIn('CONTINUATION_SELECTED', [e['event'] for e in events])
        self.assertEqual(len([e for e in events if e['event'] == 'STOP_CLICK']), 1)
        self.assertEqual([s['status'] for s in state['reminderSlots']], ['CONSUMED_BY_RECOVERY'] * 4)
        self.assertEqual(state['reminders'], [])
        self.assertIsNone(state['activeFlow'])

    def test_bridge_handoff_keeps_original_cycle_deadline(self):
        self.set_html(document(banner='<div role="status">Additional processing</div>'))
        shown = [False]
        def sleep(seconds):
            self.clock.sleep(seconds)
            if seconds == 10 and not shown[0]:
                shown[0] = True
                self.set_html(document(banner='<div role="alert">Connection interrupted</div>'))
                self.route_body = document(turns=group(body=final(self.envelope())))
        with patch.object(artifact_download, 'download_validated_artifact', return_value={
                'ok': True, 'code': artifact_download.RESULT_DURABLE, 'details': {}}):
            result, state = self.run_bridge(timeout_ms=600000, count=0, sleep=sleep)
        self.assertTrue(result['ok'], result)
        started = [e for e in state['transportEventJournal'] if e['event'] == 'RECOVERY_STARTED']
        self.assertEqual(len(started), 2)
        self.assertEqual(started[0]['deadline'], 180)
        self.assertEqual(started[1]['deadline'], started[0]['deadline'])
        self.assertGreater(started[1]['eventConfirmedAt'], started[0]['eventConfirmedAt'])

    def test_bridge_handoff_with_expired_budget_does_not_reload_again(self):
        self.set_html(document(banner='<div role="status">Additional processing</div>'))
        shown = [False]
        def sleep(seconds):
            self.clock.sleep(seconds)
            if seconds == 10 and not shown[0]:
                shown[0] = True
                self.clock.value = 180
                self.set_html(document(banner='<div role="alert">Connection interrupted</div>'))
            elif shown[0] and self.clock.value >= 200:
                self.set_html(document(turns=group(body=final(self.envelope()))))
        with patch.object(self.page, 'reload', wraps=self.page.reload) as reload, patch.object(
                artifact_download, 'download_validated_artifact', return_value={
                    'ok': True, 'code': artifact_download.RESULT_DURABLE, 'details': {}}):
            result, state = self.run_bridge(timeout_ms=600000, count=0, sleep=sleep)
        self.assertTrue(result['ok'], result)
        self.assertEqual(reload.call_count, 1)
        events = state['transportEventJournal']
        started = [e for e in events if e['event'] == 'RECOVERY_STARTED']
        self.assertEqual(len(started), 2)
        self.assertEqual(started[1]['deadline'], started[0]['deadline'])
        self.assertGreaterEqual(started[1]['startedElapsedMs'], started[0]['deadline'] * 1000)
        self.assertIn('CONNECTION_RELOADS_EXHAUSTED', [e['event'] for e in events])
        self.assertNotIn('CONTINUATION_SELECTED', [e['event'] for e in events])

    def test_bridge_weak_connection_during_system_wait_uses_normal_confirmation(self):
        self.set_html(document(banner='<div role="status">Additional processing</div>'))
        shown = [False]
        def sleep(seconds):
            self.clock.sleep(seconds)
            if seconds == 10 and not shown[0]:
                shown[0] = True
                banner = '<div>Connection interrupted. ' + 'Waiting for response. ' * 12 + '</div>'
                self.set_html(document(banner=banner))
                self.route_body = document(turns=group(body=final(self.envelope())))
        with patch.object(self.page, 'reload', wraps=self.page.reload) as reload, patch.object(
                artifact_download, 'download_validated_artifact', return_value={
                    'ok': True, 'code': artifact_download.RESULT_DURABLE, 'details': {}}):
            result, state = self.run_bridge(timeout_ms=600000, count=0, sleep=sleep)
        self.assertTrue(result['ok'], result)
        self.assertEqual(reload.call_count, 2)
        confirmed = next(e for e in state['transportEventJournal'] if e['event'] == 'SYSTEM_CONFIRMED'
                         and e['kind'] == observer.ASSISTANT_CONNECTION_INTERRUPTED)
        self.assertTrue(confirmed['confirmedOnSecondPoll'])
        self.assertGreaterEqual(confirmed['elapsedMs'], 11000)
        started = [e for e in state['transportEventJournal'] if e['event'] == 'RECOVERY_STARTED']
        self.assertEqual([e['deadline'] for e in started], [180, 180])
        self.assertNotIn('CONTINUATION_SELECTED', [e['event'] for e in state['transportEventJournal']])

    def test_bridge_result_during_system_wait_preempts_connection_handoff(self):
        self.set_html(document(banner='<div role="status">Additional processing</div>'))
        shown = [False]
        def sleep(seconds):
            self.clock.sleep(seconds)
            if seconds == 10 and not shown[0]:
                shown[0] = True
                body = '<div role="alert">Connection interrupted</div>' + final(self.envelope())
                self.set_html(document(turns=group(body=body)))
        with patch.object(self.page, 'reload', wraps=self.page.reload) as reload, patch.object(
                artifact_download, 'download_validated_artifact', return_value={
                    'ok': True, 'code': artifact_download.RESULT_DURABLE, 'details': {}}):
            result, state = self.run_bridge(count=0, sleep=sleep)
        self.assertTrue(result['ok'], result)
        self.assertEqual(reload.call_count, 1)
        events = state['transportEventJournal']
        self.assertEqual(len([e for e in events if e['event'] == 'RECOVERY_STARTED']), 1)
        aborted = [e for e in events if e['event'] == 'RECOVERY_ABORTED']
        self.assertEqual(len(aborted), 1)
        self.assertNotEqual(aborted[0]['reason'], 'serial_handoff')
        self.assertNotIn('RECOVERY_COMPLETED', [e['event'] for e in events])
        self.assertNotIn('CONTINUATION_SELECTED', [e['event'] for e in events])

    def test_bridge_connection_after_insert_cleans_prompt_before_handoff(self):
        self.set_html(document(banner='<div role="status">Additional processing</div>'))
        shown = [False]
        def sleep(seconds):
            self.clock.sleep(seconds)
            if not shown[0] and self.page.locator('#prompt-textarea').inner_text():
                shown[0] = True
                self.page.locator('main').evaluate(
                    '(el, body)=>el.insertAdjacentHTML("beforeend", body)',
                    '<div role="alert">Connection interrupted</div>')
                self.route_body = document(turns=group(body=final(self.envelope())))
        with patch.object(self.page, 'reload', wraps=self.page.reload) as reload, patch.object(
                artifact_download, 'download_validated_artifact', return_value={
                    'ok': True, 'code': artifact_download.RESULT_DURABLE, 'details': {}}):
            result, state = self.run_bridge(timeout_ms=600000, count=0, sleep=sleep)
        self.assertTrue(result['ok'], result)
        self.assertEqual(reload.call_count, 2)
        events = state['transportEventJournal']
        sent = next(e for e in events if e['event'] == 'CONTINUATION_SEND_OUTCOME')['proof']
        self.assertEqual(sent['sendState'], submit.SEND_PROVEN_NOT_SENT)
        self.assertTrue(sent['details']['unsentPromptCleared'])
        handoff = next(e for e in events if e['event'] == 'RECOVERY_ABORTED' and e['reason'] == 'serial_handoff')
        started = [e for e in events if e['event'] == 'RECOVERY_STARTED']
        self.assertEqual(len(started), 2)
        self.assertLess(handoff['sequence'], started[1]['sequence'])
        self.assertEqual([e['deadline'] for e in started], [180, 180])
        self.assertNotIn('CONTROL_SEND_CONFIRMED', [e['event'] for e in events])

    def test_bridge_connection_during_system_wait_lost_lineage_fails_closed(self):
        self.set_html(document(banner='<div role="status">Additional processing</div>'))
        shown = [False]
        def sleep(seconds):
            self.clock.sleep(seconds)
            if seconds == 10 and not shown[0]:
                shown[0] = True
                self.set_html(document(turns=group(prompt='foreign',
                    body=ACTIVITY + '<div role="alert">Connection interrupted</div>')))
        with patch.object(self.page, 'reload', wraps=self.page.reload) as reload:
            result, state = self.run_bridge(count=0, sleep=sleep)
        self.assertFalse(result['ok'])
        self.assertEqual(reload.call_count, 1)
        self.assertEqual(state['phase'], 'FAILED')
        events = state['transportEventJournal']
        self.assertEqual(len([e for e in events if e['event'] == 'RECOVERY_STARTED']), 1)
        self.assertEqual(len([e for e in events if e['event'] == 'RECOVERY_FAILED']), 1)
        self.assertNotIn('RECOVERY_COMPLETED', [e['event'] for e in events])
        self.assertNotIn('CONTINUATION_SELECTED', [e['event'] for e in events])

    def test_bridge_new_connection_during_system_wait_after_soft_deadline_no_cycle(self):
        self.set_html(document(banner='<div role="status">Additional processing</div>'))
        shown = [False]
        def sleep(seconds):
            self.clock.sleep(seconds)
            if seconds == 10 and not shown[0]:
                shown[0] = True
                self.set_html(document(banner='<div role="alert">Connection interrupted</div>'))
        with patch.object(self.page, 'reload', wraps=self.page.reload) as reload:
            result, state = self.run_bridge(timeout_ms=5000, count=0, sleep=sleep)
        self.assertFalse(result['ok'])
        self.assertEqual(reload.call_count, 1)
        self.assertEqual(state['phase'], 'TIMEOUT')
        self.assertEqual(state['lastError'], observer.ASSISTANT_TURN_TIMEOUT)
        events = state['transportEventJournal']
        self.assertEqual(len([e for e in events if e['event'] == 'RECOVERY_STARTED']), 1)
        self.assertNotIn('RECOVERY_COMPLETED', [e['event'] for e in events])
        self.assertNotIn('RECOVERY_FAILED', [e['event'] for e in events])
        self.assertNotIn('CONTINUATION_SELECTED', [e['event'] for e in events])
        self.assertLessEqual(self.clock.value, 50)

    def test_bridge_transient_connection_disappearing_during_handoff_scan_resumes(self):
        self.set_html(document(banner='<div role="status">Additional processing</div>'))
        shown = [False]
        cleared = [False]
        def sleep(seconds):
            self.clock.sleep(seconds)
            if seconds == 10 and not shown[0]:
                shown[0] = True
                self.set_html(document(banner='<div role="alert">Connection interrupted</div>'))
            elif shown[0] and not cleared[0]:
                cleared[0] = True
                self.set_html(self.route_result_after_send())
        with patch.object(self.page, 'reload', wraps=self.page.reload) as reload, patch.object(
                artifact_download, 'download_validated_artifact', return_value={
                    'ok': True, 'code': artifact_download.RESULT_DURABLE, 'details': {}}):
            result, state = self.run_bridge(count=0, sleep=sleep)
        self.assertTrue(result['ok'], result)
        self.assertEqual(reload.call_count, 1)
        events = state['transportEventJournal']
        self.assertEqual(len([e for e in events if e['event'] == 'RECOVERY_STARTED']), 1)
        self.assertEqual(len([e for e in events if e['event'] == 'CONTROL_SEND_CONFIRMED']), 1)
        self.assertNotIn('RECOVERY_FAILED', [e['event'] for e in events])
        self.assertFalse(any(e.get('reason') == 'serial_handoff' for e in events))

    def test_production_bridge_final_after_reload_cancels_continuation(self):
        self.set_html(document(banner='<div role="alert">Наши системы обрабатывают запрос</div>'))
        self.route_body = document(turns=group(body=final(self.envelope())))
        with patch.object(artifact_download, 'download_validated_artifact', return_value={
                'ok':True, 'code':artifact_download.RESULT_DURABLE, 'details':{}}):
            result, state = self.run_bridge()
        self.assertTrue(result['ok'], result)
        self.assertNotIn('CONTINUATION_SELECTED',[e['event'] for e in state['transportEventJournal']])
    def test_production_bridge_lost_lineage_never_continues_and_is_bounded(self):
        self.set_html(document(banner='<div role="status">Additional processing</div>'))
        self.route_body = document(turns=group(prompt='foreign'))
        result, state = self.run_bridge()
        self.assertFalse(result['ok'])
        self.assertEqual(state['phase'],'TIMEOUT')
        self.assertNotIn('CONTINUATION_SELECTED',[e['event'] for e in state['transportEventJournal']])
        self.assertLessEqual(self.clock.value,105)
    def test_production_bridge_connection_consumes_checkpoint_without_reminder(self):
        self.set_html(document(banner='<div role="alert">Соединение прервано</div>'))
        self.route_body = document(turns=group(body=final(self.envelope())))
        with patch.object(artifact_download, 'download_validated_artifact', return_value={
                'ok':True, 'code':artifact_download.RESULT_DURABLE, 'details':{}}):
            result, state = self.run_bridge(interval_ms=5000)
        self.assertTrue(result['ok'], result)
        self.assertEqual(state['reminderSlots'][0]['status'],'CONSUMED_BY_RECOVERY')
        self.assertEqual(state['reminders'],[])
        self.assertNotIn('CONTINUATION_SELECTED',[e['event'] for e in state['transportEventJournal']])
    def test_production_bridge_accepts_result_during_current_recovery_grace(self):
        self.route_body = self.route_result_after_send()
        signaled = [False]
        def sleep(seconds):
            if not signaled[0] and self.clock.value < 58 <= self.clock.value + seconds:
                self.clock.value = 58
                signaled[0]=True
                self.set_html(document(banner='<div role="status">Additional processing</div>'))
            else:
                self.clock.sleep(seconds)
        with patch.object(artifact_download, 'download_validated_artifact', return_value={
                'ok':True, 'code':artifact_download.RESULT_DURABLE, 'details':{}}):
            result, state = self.run_bridge(count=0, sleep=sleep)
        self.assertTrue(result['ok'], result)
        self.assertGreater(self.clock.value,60)
        self.assertLessEqual(self.clock.value,105)
        self.assertEqual(len([e for e in state['transportEventJournal'] if e['event']=='RECOVERY_STARTED']),1)
    def test_production_bridge_no_new_cycle_or_reminder_after_grace_cycle(self):
        signaled=[False]
        def sleep(seconds):
            if not signaled[0] and self.clock.value < 58 <= self.clock.value + seconds:
                self.clock.value = 58
                signaled[0]=True
                self.set_html(document(banner='<div role="status">Additional processing</div>'))
            else:
                self.clock.sleep(seconds)
        result, state = self.run_bridge(count=0, sleep=sleep)
        self.assertFalse(result['ok'])
        self.assertEqual(state['phase'],'TIMEOUT')
        self.assertGreater(self.clock.value,60)
        self.assertLessEqual(self.clock.value,105)
        self.assertEqual(len([e for e in state['transportEventJournal'] if e['event']=='RECOVERY_STARTED']),1)
        self.assertEqual(len([e for e in state['transportEventJournal'] if e['event']=='CONTROL_SEND_CONFIRMED']),1)

    def test_production_bridge_text_result_within_recovery_grace_is_accepted(self):
        self.route_body = document(turns=group(body=final('Итоговый ответ без ZIP')))
        signaled = [False]
        def sleep(seconds):
            if not signaled[0] and self.clock.value < 58 <= self.clock.value + seconds:
                self.clock.value=58
                signaled[0]=True
                self.set_html(document(banner='<div role="status">Additional processing</div>'))
            else:
                self.clock.sleep(seconds)
        result, state = self.run_bridge(count=0, sleep=sleep)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['code'],bridge_module.ASSISTANT_COMPLETED_NO_ARTIFACT)
        self.assertIn('Итоговый ответ', state['assistantText'])
        self.assertGreater(self.clock.value,60)
        self.assertLessEqual(self.clock.value,105)
    def test_production_bridge_ongoing_banner_is_not_a_second_event(self):
        banner='<div role="status">Additional processing</div>'
        self.set_html(document(banner=banner))
        self.route_body=document(banner=banner)
        result, state = self.run_bridge(timeout_ms=40000, count=0)
        self.assertFalse(result['ok'])
        events=state['transportEventJournal']
        self.assertEqual(len([e for e in events if e['event']=='RECOVERY_STARTED']),1)
        self.assertEqual(len([e for e in events if e['event']=='CONTROL_SEND_CONFIRMED']),1)
        self.assertEqual(state['detectorDiagnostics'][observer.ADDITIONAL_PROCESSING]['confirmedCount'],1)
    def bounded_connection_reload(self):
        # Keep real detector, Page.reload and production re-proof; shorten only
        # injected per-attempt timings so exhaustion precedes the request deadline.
        real = recovery.recover_interrupted_chat
        def recover(*args, **kwargs):
            return real(*args, **kwargs, load_timeout_ms=1000, settle_ms=0,
                        poll_ms=1000, retry_delays_ms=(0, 0, 0))
        return patch.object(recovery, 'recover_interrupted_chat', side_effect=recover)

    def test_bridge_exhausted_connection_waits_then_reproves_and_resumes(self):
        self.route_body = document(banner='<div role="alert">Connection interrupted</div>')
        self.set_html(self.route_body)
        changed = set()
        def sleep(seconds):
            self.clock.sleep(seconds)
            if self.clock.value >= 20 and 'absent' not in changed:
                changed.add('absent')
                self.set_html(document())
            if self.clock.value >= 40 and 'final' not in changed:
                changed.add('final')
                self.set_html(document(turns=group(body=final(self.envelope()))))
        with self.bounded_connection_reload(), patch.object(self.page, 'reload', wraps=self.page.reload) as reload, patch.object(
                artifact_download, 'download_validated_artifact', return_value={
                    'ok': True, 'code': artifact_download.RESULT_DURABLE, 'details': {}}):
            result, state = self.run_bridge(interval_ms=10000, count=2, sleep=sleep)
        self.assertTrue(result['ok'], result)
        self.assertEqual(reload.call_count, 3)
        events = state['transportEventJournal']
        waiting = next(e for e in events if e.get('phase') == 'CONNECTION_WAITING')
        resumed = next(e for e in events if e.get('previous') == 'CONNECTION_WAITING' and e.get('phase') == 'WORKING')
        self.assertLess(waiting['elapsedMs'], 20000)
        self.assertGreaterEqual(resumed['elapsedMs'], 20000)
        self.assertLess(resumed['elapsedMs'], 40000)
        self.assertEqual(len([e for e in events if e['event'] == 'RELOAD_STARTED']), 3)
        self.assertTrue(any(e['event'] == 'SAME_CHAT_CONFIRMED' and e.get('passive') for e in events))
        self.assertEqual([s['status'] for s in state['reminderSlots']], ['CONSUMED_BY_RECOVERY'] * 2)
        self.assertEqual(state['reminders'], [])
        self.assertNotIn('CONTINUATION_SELECTED', [e['event'] for e in events])
        self.assertEqual(len([e for e in events if e['event'] == 'RECOVERY_COMPLETED']), 1)
        self.assertNotIn('RECOVERY_FAILED', [e['event'] for e in events])

    def test_bridge_continuous_exhausted_connection_times_out_without_reload_storm(self):
        self.route_body = document(banner='<div role="alert">Connection interrupted</div>')
        self.set_html(self.route_body)
        with self.bounded_connection_reload(), patch.object(self.page, 'reload', wraps=self.page.reload) as reload:
            result, state = self.run_bridge(interval_ms=10000, count=5)
        self.assertFalse(result['ok'])
        self.assertEqual(reload.call_count, 3)
        self.assertEqual(self.clock.value, 60)
        self.assertEqual(state['phase'], 'TIMEOUT')
        self.assertEqual(state['lastError'], observer.ASSISTANT_TURN_TIMEOUT)
        self.assertEqual(state['reminders'], [])
        self.assertEqual([s['status'] for s in state['reminderSlots']], ['CONSUMED_BY_RECOVERY'] * 5)
        events = state['transportEventJournal']
        self.assertEqual(len([e for e in events if e['event'] == 'RECOVERY_STARTED']), 1)
        self.assertEqual(len([e for e in events if e['event'] == 'RECOVERY_ABORTED']), 1)
        self.assertNotIn('RECOVERY_COMPLETED', [e['event'] for e in events])
        self.assertNotIn('RECOVERY_FAILED', [e['event'] for e in events])

    def test_bridge_disappearance_rearms_a_genuine_new_connection_episode(self):
        banner = '<div role="alert">Connection interrupted</div>'
        self.route_body = document(banner=banner)
        self.set_html(self.route_body)
        changed = set()
        def sleep(seconds):
            self.clock.sleep(seconds)
            if self.clock.value >= 20 and 'absent' not in changed:
                changed.add('absent')
                self.set_html(document())
            if self.clock.value >= 35 and 'new' not in changed:
                changed.add('new')
                self.route_body = document()
                self.set_html(document(banner=banner))
            if self.clock.value >= 55 and 'final' not in changed:
                changed.add('final')
                self.set_html(document(turns=group(body=final(self.envelope()))))
        with self.bounded_connection_reload(), patch.object(self.page, 'reload', wraps=self.page.reload) as reload, patch.object(
                artifact_download, 'download_validated_artifact', return_value={
                    'ok': True, 'code': artifact_download.RESULT_DURABLE, 'details': {}}):
            result, state = self.run_bridge(count=0, sleep=sleep)
        self.assertTrue(result['ok'], result)
        self.assertEqual(reload.call_count, 4)
        started = [e for e in state['transportEventJournal'] if e['event'] == 'RECOVERY_STARTED']
        self.assertEqual(len(started), 2)
        self.assertNotEqual(started[0]['eventId'], started[1]['eventId'])
        self.assertEqual(state['bannerEpisodes'][observer.ASSISTANT_CONNECTION_INTERRUPTED]['number'], 2)

    def test_bridge_result_preempts_connection_waiting_even_with_banner_present(self):
        banner = '<div role="alert">Connection interrupted</div>'
        self.route_body = document(banner=banner)
        self.set_html(self.route_body)
        def sleep(seconds):
            self.clock.sleep(seconds)
            if self.clock.value >= 20:
                self.set_html(document(turns=group(body=banner + final(self.envelope()))))
        with self.bounded_connection_reload(), patch.object(self.page, 'reload', wraps=self.page.reload) as reload, patch.object(
                artifact_download, 'download_validated_artifact', return_value={
                    'ok': True, 'code': artifact_download.RESULT_DURABLE, 'details': {}}):
            result, state = self.run_bridge(count=0, sleep=sleep)
        self.assertTrue(result['ok'], result)
        self.assertEqual(reload.call_count, 3)
        events = state['transportEventJournal']
        self.assertEqual(len([e for e in events if e['event'] == 'RECOVERY_ABORTED']), 1)
        self.assertNotIn('RECOVERY_COMPLETED', [e['event'] for e in events])
        self.assertNotIn('CONTINUATION_SELECTED', [e['event'] for e in events])

    def deadline_return_race(self, confirmed_at, *, persistent=False):
        # Wrap actual observer, not its returned dict. Detector confirmation runs
        # at confirmed_at; only the scheduling/return delay crosses soft timeout.
        real = observer.observe_next_assistant
        delayed = [False]
        def observe(*args, **kwargs):
            result = real(*args, **kwargs)
            if result['code'] == observer.ASSISTANT_CONNECTION_INTERRUPTED and not delayed[0]:
                delayed[0] = True
                self.clock.value = 60.1
            return result
        shown = [False]
        def sleep(seconds):
            if not shown[0] and self.clock.value < confirmed_at <= self.clock.value + seconds + 0.2:
                shown[0] = True
                self.clock.value = confirmed_at
                self.set_html(document(banner='<div role="alert">Connection interrupted</div>'))
            else:
                self.clock.sleep(seconds)
        self.route_body = (document(banner='<div role="alert">Connection interrupted</div>') if persistent
                           else document(turns=group(body=final(self.envelope()))))
        with patch.object(observer, 'observe_next_assistant', side_effect=observe), patch.object(
                self.page, 'reload', wraps=self.page.reload) as reload, patch.object(
                artifact_download, 'download_validated_artifact', return_value={
                    'ok': True, 'code': artifact_download.RESULT_DURABLE, 'details': {}}):
            result, state = self.run_bridge(count=0, sleep=sleep)
        return result, state, reload.call_count

    def test_confirmed_before_soft_deadline_starts_after_observer_returns_late(self):
        result, state, reloads = self.deadline_return_race(59.9)
        self.assertTrue(result['ok'], result)
        self.assertEqual(reloads, 1)
        started = next(e for e in state['transportEventJournal'] if e['event'] == 'RECOVERY_STARTED')
        self.assertAlmostEqual(started['eventConfirmedAt'], 59.9)
        self.assertGreaterEqual(started['startedElapsedMs'], 60100)
        self.assertEqual(started['deadline'], 105)
        self.assertGreater(self.clock.value, 60)
        self.assertLessEqual(self.clock.value, 105)

    def test_predeadline_race_persistent_banner_respects_hard_deadline(self):
        result, state, reloads = self.deadline_return_race(59.9, persistent=True)
        self.assertFalse(result['ok'])
        self.assertEqual(state['phase'], 'TIMEOUT')
        self.assertEqual(reloads, 1)
        self.assertEqual(self.clock.value, 105)
        self.assertEqual(len([e for e in state['transportEventJournal'] if e['event'] == 'RECOVERY_STARTED']), 1)

    def test_first_confirmation_after_soft_deadline_never_starts_recovery(self):
        result, state, reloads = self.deadline_return_race(60.1)
        self.assertFalse(result['ok'])
        self.assertEqual(state['phase'], 'TIMEOUT')
        self.assertEqual(reloads, 0)
        self.assertNotIn('RECOVERY_STARTED', [e['event'] for e in state['transportEventJournal']])

    def test_system_continuation_unknown_send_stops_without_resend(self):
        self.set_html(document(banner='<div role="status">Additional processing</div>'))
        real_click = Locator.click
        sends = []
        def click(locator, *args, **kwargs):
            is_send = locator.get_attribute('data-testid') == 'send-button'
            real_click(locator, *args, **kwargs)
            if is_send:
                sends.append(locator)
                raise RuntimeError('Send reached DOM, response lost')
        with patch.object(Locator, 'click', new=click):
            result, state = self.run_bridge()
        self.assertFalse(result['ok'])
        self.assertEqual(len(sends), 1)
        self.assertIn('UNKNOWN', state['lastError'])
        self.assertEqual(state['phase'],'FAILED')
        self.assertEqual(len([e for e in state['transportEventJournal'] if e['event']=='CONTINUATION_SELECTED']),1)
        events = state['transportEventJournal']
        failed = [e for e in events if e['event'] == 'RECOVERY_FAILED']
        self.assertEqual(len(failed), 1)
        self.assertIn('UNKNOWN', failed[0]['reason'])
        self.assertEqual(failed[0]['code'], bridge_module.BRIDGE_PIPELINE_FAILED)
        self.assertNotIn('RECOVERY_COMPLETED', [e['event'] for e in events])
        self.assertNotIn('RECOVERY_ABORTED', [e['event'] for e in events])
        failure_transition = next(e for e in events if e.get('phase') == 'FAILED')
        self.assertLess(failed[0]['sequence'], failure_transition['sequence'])

    def test_changed_intent_prefix_before_send_is_fail_closed(self):
        intent = transport.make_intent(self.page, REQ, URL, PROMPT, PROMPT,
                                      slot=1, randrange=lambda _:0)
        def sleep(seconds):
            self.clock.sleep(seconds)
            self.page.locator('[data-user-message-bubble]').first.evaluate('(el)=>el.textContent += " changed"')
        result = reminders.submit_reminder(self.page, intent['exactPromptText'], URL,
            anchor_prompt=PROMPT, control_intent=intent, sleep=sleep, monotonic=self.clock.now,
            uniform=lambda a,b: 1)
        self.assertFalse(result['ok'])
        self.assertEqual(result['sendState'],submit.SEND_PROVEN_NOT_SENT)
        self.assertEqual(result['details']['answerPhase']['reason'],'control_intent_lineage_changed')
        self.assertIsNone(self.page.evaluate('window.sends'))
        self.assertEqual(self.page.locator('#prompt-textarea').inner_text(),'')


if __name__ == '__main__':
    unittest.main()
