"""Real Chromium DOM: banners, re-proof, natural Send and result correlation."""
import html
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
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
import input_attachment as attachments
import reminder_policy as reminders
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

    def test_collapsed_modern_bubble_reads_only_long_semantic_payload(self):
        prompt = self.long_image_prompt()
        self.assertGreater(len(prompt), 2048)
        for toggle in ('Показать ещё', 'Show more', '任意のラベル'):
            with self.subTest(toggle=toggle):
                payload = ''.join('<p>' + html.escape(line) + '</p>' for line in prompt.split('\n'))
                self.set_html(document(turns='<div data-user-message-bubble="true">'
                    '<div data-testid="collapsible-user-message-content" style="max-height:80px;overflow:hidden">'
                    + payload + '</div><button>…\n' + toggle + '</button></div>'))
                bubble = self.page.locator('[data-user-message-bubble="true"]')
                # Playwright's chained CSS locator finds descendants, not the root itself.
                self.assertEqual(bubble.locator('[data-user-message-bubble="true"]').count(), 0)
                self.assertIsNone(bubble.get_attribute('data-message-author-role'))
                semantic, selector = submit.find_user_message_content(bubble)
                self.assertEqual(selector, '[data-testid="collapsible-user-message-content"]')
                text = submit.read_semantic_message_text(semantic)
                self.assertEqual(text, prompt)
                self.assertEqual(len(text), len(prompt))
                self.assertEqual(submit.prompt_sha256(text), submit.prompt_sha256(prompt))
                self.assertNotIn(toggle, text)
                self.assertNotEqual(submit.read_semantic_message_text(bubble), prompt)
                ok, proof = submit._observe_send_proof(self.page, prompt, 0, conversation_url=URL)
                self.assertTrue(ok, proof)
                self.assertTrue(proof['exactUserTurn'])
                self.assertTrue(proof['userTurnCorrelated'])
                self.assertEqual(proof['userTurnCorrelationMode'], 'exact')
                self.assertEqual(proof['userTurnTextSha256'], submit.prompt_sha256(prompt))
        # UI-looking words inside the payload remain user text, not a blacklist.
        literal = 'Пользователь написал: Показать ещё, Show more и …'
        self.set_html(document(turns='<div data-user-message-bubble="true">'
            '<div data-testid="collapsible-user-message-content">' + literal
            + '</div><button>Показать ещё</button></div>'))
        self.assertEqual(submit.collect_user_turn_texts(self.page), [literal])

    def test_current_composer_photo_control_is_unique_before_reading_bytes(self):
        controls = '<input id="video" type="file" accept="image/*,video/*">' \
                   '<input id="photo" type="file" accept="image/*">' \
                   '<input id="generic" type="file">'
        cases = [(controls, 'photo', 1), ('', None, 0),
                 ('<input type="file" accept="application/pdf">', None, 0),
                 (controls + '<input type="file" accept="image/*">', None, 2),
                 ('<input type="file" accept="image/*" disabled>', None, 0),
                 ('<input type="file"><input type="file" accept="image/*,video/*">', None, 2)]
        for inputs, expected, eligible in cases:
            with self.subTest(inputs=inputs):
                self.set_html('<div class="ProseMirror" contenteditable="true" role="textbox">unrelated editor</div>'
                    '<input type="file" accept="image/*" id="unrelated">'
                    '<form data-chatgpt-composer data-composer-placement="thread">' + COMPOSER + inputs + '</form>')
                composer, _ = submit.find_composer(self.page)
                self.assertEqual(composer.get_attribute('id'), 'prompt-textarea')
                self.assertEqual(len(submit.collect_composer_snapshots(self.page)['logicalCandidates']), 1)
                reads, uploads = [], []
                attachment = SimpleNamespace(name='reference.png', media_type='image/png',
                    upload_bytes=lambda: reads.append('bytes') or b'synthetic image fixture')
                def native_upload(node, payload, **kwargs):
                    uploads.append(node.get_attribute('id'))
                    self.assertEqual(reads, ['bytes'])
                proof = {'known': True, 'count': 1, 'names': ['reference.png'],
                         'pending': False, 'error': False, 'settled': True, 'ids': ['fixture']}
                with patch.object(Locator, 'set_input_files', new=native_upload), \
                     patch.object(attachments, 'snapshot', side_effect=[{'known': True, 'count': 0}, proof]):
                    result = attachments.upload(self.page, self.page.locator('#prompt-textarea'), attachment,
                        wait_until=lambda fn, **kw: fn(), timeout_ms=0)
                self.assertEqual(result['ok'], expected is not None, result)
                self.assertEqual(reads, ['bytes'] if expected else [])
                self.assertEqual(uploads, [expected] if expected else [])
                self.assertEqual(result['details']['eligibleCount'], eligible)
                self.assertEqual(result['details']['scopeFileInputCount'], len(inputs.split('<input')) - 1)
                self.assertEqual(result['details']['fileInputCount'], result['details']['scopeFileInputCount'] + 1)
                self.assertEqual(result['details']['container'], 'active-composer-form')

    def test_multiple_or_hidden_current_forms_never_select_a_composer(self):
        form = '<form data-chatgpt-composer data-composer-placement="thread">' + COMPOSER + '</form>'
        # Two visible current forms are ambiguous; one hidden form is inactive.
        for forms in (form + form, form.replace('<form ', '<form hidden ')):
            self.set_html(forms)
            self.assertEqual(submit.find_composer(self.page), (None, None))

    def test_current_user_payload_and_image_only_answer_share_exact_anchor(self):
        prompt = self.long_image_prompt()
        self.set_html(document(turns=group(body='<div data-testid="generated-image-gallery"></div>', key='old') +
            '<div data-turn-key="current"><div data-user-message-bubble="true">'
            '<div data-search-result-target style="max-height:80px;overflow:hidden">'
            '<div><div class="text-size-chat whitespace-pre-wrap" dir="auto">' + html.escape(prompt) +
            '</div></div></div><span aria-hidden="true">…</span><button aria-expanded="false">Показать ещё</button>'
            '</div><div data-testid="generated-image-gallery"></div></div>'))
        # Synthetic decoded images: no user image or third-party network.
        self.page.evaluate('''() => {
            const canvas = document.createElement('canvas'); canvas.width=128;canvas.height=128;
            for (const gallery of document.querySelectorAll('[data-testid="generated-image-gallery"]')) {
                const img = new Image();img.src=canvas.toDataURL();gallery.append(img);
            }
            const avatar = new Image();avatar.src=canvas.toDataURL();document.body.prepend(avatar);
        }''')
        self.page.wait_for_function('[...document.querySelectorAll("[data-testid=generated-image-gallery] img")].every(i=>i.complete)')
        self.assertEqual(submit.collect_user_turn_texts(self.page), [PROMPT, prompt])
        self.assertTrue(submit._observe_send_proof(self.page, prompt, 1, conversation_url=URL)[0])
        result = observer.observe_next_assistant(self.page, prompt, URL, image_mode=True,
            timeout_ms=1000, stable_ms=100, poll_ms=10, sleep=self.clock.sleep, monotonic=self.clock.now)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['details']['assistantText'], '')
        self.assertEqual(result['details']['assistantImageCount'], 1)
        self.assertEqual(result['details']['anchorIndex'], 2)
        self.assertEqual(result['details']['assistantIndex'], 3)
        for content in (html.escape(prompt[:100]), '<span hidden>' + html.escape(prompt) + '</span>'):
            self.page.locator('[data-search-result-target] .whitespace-pre-wrap').evaluate('(el, text)=>el.innerHTML=text', content)
            self.assertFalse(submit._observe_send_proof(self.page, prompt, 1, conversation_url=URL)[0])

    @staticmethod
    def long_image_prompt():
        return '\n'.join([
            f'POSTMAN_REQUEST_ID: {REQ}', '## Input files', '### image.png',
            'repository: https://example.test/input-fixture', 'commit: ' + 'a' * 40,
            'raw_url: https://example.test/image.png', 'Сгенерируй иллюстрацию по входному изображению.',
            *[f'{i}. Сохрани композицию, мягкий свет, естественные цвета и детали исходного изображения.'
              for i in range(1, 31)], 'Сделай ровно одно изображение.',
        ])

    def test_user_container_fallback_and_controls_remain_fail_closed(self):
        for attrs in ('data-user-message-bubble="true"', 'data-message-author-role="user"'):
            with self.subTest(attrs=attrs, case='plain'):
                self.set_html(document(turns=f'<div {attrs}>{html.escape(PROMPT)}</div>'))
                self.assertEqual(submit.collect_user_turn_texts(self.page), [PROMPT])
                self.assertTrue(submit._observe_send_proof(self.page, PROMPT, 0)[0])
            for control in ('<button>Показать ещё</button>', '<span role="button">Show more</span>',
                            '<span data-collapsed="true">…</span>'):
                with self.subTest(attrs=attrs, control=control):
                    self.set_html(document(turns=f'<div {attrs}>{html.escape(PROMPT)}{control}</div>'))
                    turn = self.page.locator('main > div')
                    self.assertEqual(submit.find_user_message_content(turn), (None, None))
                    self.assertEqual(submit.collect_user_turn_texts(self.page), [''])
                    ok, proof = submit._observe_send_proof(self.page, PROMPT, 0)
                    self.assertFalse(ok)
                    self.assertFalse(proof['exactUserTurn'])
                    self.assertFalse(proof['userTurnCorrelated'])
            with self.subTest(attrs=attrs, case='dedicated payload'):
                self.set_html(document(turns=f'<div {attrs}>'
                    '<div data-testid="collapsible-user-message-content" hidden>hidden payload</div>'
                    '<div data-testid="collapsible-user-message-content">' + html.escape(PROMPT)
                    + '</div><button>Show more</button></div>'))
                self.assertEqual(submit.collect_user_turn_texts(self.page), [PROMPT])
                self.assertTrue(submit._observe_send_proof(self.page, PROMPT, 0)[0])

    def test_long_collapsed_image_send_proves_exact_text_and_sibling_attachment(self):
        prompt = self.long_image_prompt()
        name = f'POSTMAN_INPUT_{REQ}.zip'
        attachment = SimpleNamespace(name=name, metadata=lambda: {'requestId': REQ, 'displayName': name})
        self.set_html('<main></main><form>' + COMPOSER
            + '<div data-composer-attachments><div data-testid="file-upload-preview" '
              'data-file-id="input-1" data-upload-state="ready" data-filename="' + name + '">'
              '<button type="button">input image bundle</button></div></div></form>'
              '<button data-testid="send-button">Send</button>')
        self.page.evaluate("history.replaceState(null, '', '/')")
        self.page.evaluate(r'''() => {
            document.querySelector('[data-testid="send-button"]').onclick = () => {
                const composer = document.querySelector('#prompt-textarea');
                const turn = document.createElement('div');
                turn.setAttribute('data-content-search-unit-key', 'image-fixture:user');
                const bubble = document.createElement('div');
                bubble.setAttribute('data-user-message-bubble', 'true');
                const payload = document.createElement('div');
                payload.setAttribute('data-testid', 'collapsible-user-message-content');
                payload.style.cssText = 'max-height:80px;overflow:hidden';
                payload.innerHTML = composer.innerHTML;
                const toggle = document.createElement('button');
                toggle.textContent = '…\nПоказать ещё';
                bubble.append(payload, toggle);
                turn.append(document.querySelector('[data-testid="file-upload-preview"]'), bubble);
                document.querySelector('main').append(turn);
                composer.innerHTML = '';
                history.replaceState(null, '', '/c/recovery-fixture');
                window.sends = (window.sends || 0) + 1;
            };
        }''')
        self.assertEqual(submit.collect_user_turn_details(self.page), [])
        composer, _ = submit.find_composer(self.page)
        inserted = submit.insert_prompt(self.page, composer, prompt, timeout_ms=1000)
        self.assertTrue(inserted['ok'], inserted)
        self.assertEqual(inserted['details']['observedTextLength'], len(prompt))
        self.assertEqual(inserted['details']['observedTextSha256'], submit.prompt_sha256(prompt))
        guard = submit.SendGuard()
        result = submit.submit_once(self.page, composer, prompt, guard, timeout_ms=1000,
            input_attachment=attachment, attachment_id='input-1')
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['code'], submit.PROMPT_SEND_CONFIRMED)
        self.assertEqual(result['sendState'], submit.SEND_PROVEN_SENT)
        self.assertEqual(self.page.evaluate('window.sends'), 1)
        proof = result['details']
        self.assertEqual((proof['userTurnCountBefore'], proof['userTurnCountNow']), (0, 1))
        for key in ('exactUserTurn', 'userTurnCorrelated', 'composerEmpty', 'chatUrlBound', 'sentAttachmentConfirmed'):
            self.assertTrue(proof[key], proof)
        self.assertEqual(proof['userTurnCorrelationMode'], 'exact')
        self.assertEqual(proof['userTurnTextLength'], len(prompt))
        self.assertEqual(proof['userTurnTextSha256'], submit.prompt_sha256(prompt))
        self.assertEqual(proof['userTurnSemanticSelector'], '[data-testid="collapsible-user-message-content"]')
        self.assertEqual(proof['sentAttachment']['names'], [name])
        self.assertEqual(proof['sentAttachment']['ids'], ['input-1'])
        self.assertEqual(self.page.locator('[data-user-message-bubble] [data-testid="file-upload-preview"]').count(), 0)
        # Exact text does not excuse a different file or borrow a previous turn's card.
        card = self.page.locator('[data-testid="file-upload-preview"]')
        for attr, value in (('data-filename', 'wrong.zip'), ('data-file-id', 'wrong-id')):
            card.evaluate('(el, pair) => el.setAttribute(pair[0], pair[1])', [attr, value])
            ok, rejected = submit._observe_send_proof(self.page, prompt, 0,
                input_attachment=attachment, attachment_id='input-1', conversation_url=URL)
            self.assertFalse(ok)
            self.assertTrue(rejected['exactUserTurn'])
            self.assertFalse(rejected['sentAttachmentConfirmed'])
            card.evaluate('(el, pair) => el.setAttribute(pair[0], pair[1])',
                [attr, name if attr == 'data-filename' else 'input-1'])
        card.evaluate('''el => {
            const previous = document.createElement('div');
            previous.setAttribute('data-content-search-unit-key', 'previous:user');
            document.querySelector('main').prepend(previous); previous.append(el);
        }''')
        ok, rejected = submit._observe_send_proof(self.page, prompt, 0,
            input_attachment=attachment, attachment_id='input-1', conversation_url=URL)
        self.assertFalse(ok)
        self.assertTrue(rejected['exactUserTurn'])
        self.assertFalse(rejected['sentAttachmentConfirmed'])
        self.assertEqual(self.page.evaluate('window.sends'), 1)

    def test_photo_control_waits_for_hydration_before_single_upload(self):
        import input_attachment
        self.set_html('<form>' + COMPOSER + '<input type="file" accept="image/*" disabled>'
                      '<div data-composer-attachments></div></form>')
        attachment=SimpleNamespace(name=f'POSTMAN_REFERENCE_{REQ}.png',media_type='image/png',upload_bytes=lambda:b'fixture')
        calls=[]
        def wait(check, **kwargs):
            calls.append(1)
            if len(calls)==1:
                self.assertFalse(check()[0])
                self.page.locator('input').evaluate('e=>e.disabled=false')
                self.assertTrue(check()[0])
                return True,{}
            return True,{'known':True,'count':1,'names':[attachment.name],'pending':False,'error':False,'settled':True}
        from unittest.mock import patch
        with patch.object(input_attachment,'snapshot',return_value={'known':True,'count':0,'pending':False,'error':False}):
            result=input_attachment.upload(self.page,self.page.locator('#prompt-textarea'),attachment,timeout_ms=100,wait_until=wait)
        self.assertTrue(result['ok'],result)
        self.assertEqual(len(calls),2)
        self.assertEqual(self.page.locator('input').evaluate('e=>e.files.length'),1)

    def test_local_uploaded_conversation_reloads_read_only_never_resends(self):
        from unittest.mock import patch
        attachment = SimpleNamespace(name=f'POSTMAN_REFERENCE_{REQ}.png')
        self.set_html(document(turns=''))
        self.page.locator('#prompt-textarea').fill(PROMPT)
        local = {'exactUserTurn':True,'composerEmpty':True,'chatUrlBound':True,'chatUrl':URL,
                 'sentAttachmentConfirmed':False,'sentAttachment':{
                     'reason':'uploaded_source_unbound','duplicateSource':False,
                     'observedImageSource':'uploaded','observedConversationId':'local-chatgpt:fixture'}}
        proven = {**local,'sentAttachmentConfirmed':True}
        guard=submit.SendGuard()
        found={'found':True,'button':self.page.locator('[data-testid="send-button"]'),'selector':'[data-testid="send-button"]'}
        with patch.object(submit.attachments,'before_send',return_value=(True,{})), \
             patch.object(submit,'_wait_until',side_effect=[(True,found),(False,local),(True,proven)]), \
             patch.object(type(self.page),'reload',return_value=None) as reload:
            result=submit.submit_once(self.page,self.page.locator('#prompt-textarea'),PROMPT,guard,
                timeout_ms=100,conversation_url=URL,input_attachment=attachment,
                chat_confirmed_state=submit.CHAT_URL_BOUND)
        self.assertEqual(result['sendState'],'PROVEN_SENT',result)
        self.assertTrue(result['details']['sentImageReadOnlyReload'])
        reload.assert_called_once()
        self.assertEqual(self.page.evaluate('window.sends'),1)
        self.assertEqual(submit.submit_once(self.page,self.page.locator('#prompt-textarea'),PROMPT,guard)['code'],
                         submit.PROMPT_RESEND_BLOCKED)
        self.assertEqual(self.page.evaluate('window.sends'),1)

    def test_live_sibling_user_thumbnail_is_not_generated_result(self):
        self.set_html(document(turns=group(body=
            '<div data-chatgpt-search-unit-key="fallback-turn-0:0:user">'
            '<div role="button" aria-label="Приложение пользователя"><img alt="Приложение пользователя"></div></div>'
            '<div data-testid="generated-image-gallery"><button data-testid="generated-image-preview">'
            '<img alt="Сгенерированное изображение 1"></button></div>')))
        self.page.evaluate('''()=>{const c=document.createElement('canvas');c.width=128;c.height=128;
            for(const i of document.querySelectorAll('img'))i.src=c.toDataURL();}''')
        self.page.wait_for_function('[...document.querySelectorAll("img")].every(i=>i.naturalWidth>0)')
        turn = self.page.locator('[data-turn-key]')
        self.assertEqual(turn.locator('img').count(), 2)
        self.assertEqual(observer.count_turn_images(turn), 1)

    def test_live_uploaded_thumbnail_requires_scoped_component_identity(self):
        name = f'POSTMAN_REFERENCE_{REQ}.png'
        attachment = SimpleNamespace(name=name, metadata=lambda: {})
        prompt = 'точный исходный запрос'
        self.set_html(document(turns='<div data-chatgpt-search-unit-key="fallback-turn-0:0:user" '
            'data-chatgpt-search-message-ids="message-1"><div role="button" '
            'aria-label="Приложение пользователя"><img alt="Приложение пользователя"></div>'
            '<div data-content-search-unit-key="fallback-turn-0:0:user">'
            '<div data-user-message-bubble="true"><div data-search-result-target>'
            '<div class="whitespace-pre-wrap">' + prompt + '</div></div></div></div></div>'))
        self.page.evaluate('''name => {
            const image = document.querySelector('img');
            const canvas = document.createElement('canvas');canvas.width=2;canvas.height=2;
            image.src=canvas.toDataURL();
            const scope=image.closest('[data-chatgpt-search-unit-key]');
            const id='sediment://file_fixture1';
            window.uploadItem={type:'user-message',messageId:'message-1',serverMessageId:'message-1',
                images:[id],chatGptImageAttachments:[{fileId:'file_fixture1',name,mimeType:'image/png'}]};
            window.uploadSource={src:id,id,status:'completed'};
            window.sourceProps={sourceImage:uploadSource,imageSource:'uploaded',chatGptConversationId:'recovery-fixture'};
            image.__reactFiber$fixture={memoizedProps:{},return:{memoizedProps:sourceProps,
                return:{memoizedProps:{item:uploadItem,conversationId:'recovery-fixture',pendingAttachment:null},
                    return:{stateNode:scope}}}};
        }''', name)
        self.page.wait_for_function('document.querySelector("img").naturalWidth > 0')
        def proof(text=prompt):
            return submit._observe_send_proof(self.page, text, 0, conversation_url=URL,
                input_attachment=attachment, attachment_id='file_fixture1')
        turns = submit.collect_user_turn_details(self.page, name)
        self.assertEqual(turns[0]['text'], prompt)
        self.assertEqual(turns[0]['attachment']['names'], [name])
        self.assertTrue(proof()[0], proof())
        self.assertTrue(proof()[1]['sentAttachmentConfirmed'])
        for mutation, restore in [
            ("uploadItem.chatGptImageAttachments[0].name='old.png'", "uploadItem.chatGptImageAttachments[0].name=" + repr(name)),
            ("uploadSource.id='sediment://file_other'", "uploadSource.id='sediment://file_fixture1'"),
            ("uploadItem.messageId='message-other'", "uploadItem.messageId='message-1'"),
            ("sourceProps.imageSource='generated'", "sourceProps.imageSource='uploaded'"),
            ("sourceProps.chatGptConversationId='other'", "sourceProps.chatGptConversationId='recovery-fixture'"),
            ("uploadItem.type='assistant-message'", "uploadItem.type='user-message'")]:
            with self.subTest(mutation=mutation):
                self.page.evaluate(mutation)
                self.assertFalse(proof()[0])
                self.assertFalse(proof()[1]['sentAttachmentConfirmed'])
                self.page.evaluate(restore)
        self.assertFalse(proof('другой запрос')[0])
        image = self.page.locator('img')
        for target in ('old:user', 'next:user', 'result:assistant'):
            with self.subTest(target=target):
                image.evaluate('''(image,key)=>{
                    const other=document.createElement('div');other.setAttribute('data-chatgpt-search-unit-key',key);
                    document.querySelector('main').append(other);other.append(image.parentElement);
                }''', target)
                self.assertFalse(proof()[0])
                self.assertFalse(proof()[1]['sentAttachmentConfirmed'])
                image.evaluate('''image=>document.querySelector('[data-chatgpt-search-message-ids="message-1"]').prepend(image.parentElement)''')
        self.assertTrue(proof()[0])

    def test_truncated_collapsed_payload_stays_unknown_without_resend(self):
        prompt = self.long_image_prompt()
        self.set_html(document(turns=''))
        self.page.locator('[data-testid="send-button"]').evaluate(r'''button => {
            button.onclick = () => {
                const composer = document.querySelector('#prompt-textarea');
                const bubble = document.createElement('div'); bubble.setAttribute('data-user-message-bubble', 'true');
                const payload = document.createElement('div'); payload.setAttribute('data-testid', 'collapsible-user-message-content');
                payload.textContent = composer.textContent.slice(0, 160);
                const toggle = document.createElement('button'); toggle.textContent = 'Show more';
                bubble.append(payload, toggle); document.querySelector('main').append(bubble);
                composer.innerHTML = ''; window.sends = (window.sends || 0) + 1;
            };
        }''')
        composer, _ = submit.find_composer(self.page)
        self.assertTrue(submit.insert_prompt(self.page, composer, prompt, timeout_ms=1000)['ok'])
        guard = submit.SendGuard()
        result = submit.submit_once(self.page, composer, prompt, guard, timeout_ms=0)
        self.assertEqual(result['code'], submit.PROMPT_SEND_UNKNOWN)
        self.assertEqual(result['sendState'], submit.SEND_UNKNOWN)
        self.assertFalse(result['details']['exactUserTurn'])
        self.assertFalse(result['details']['userTurnCorrelated'])
        self.assertEqual(result['details']['userTurnCorrelationMode'], 'none')
        blocked = submit.submit_once(self.page, composer, prompt, guard, timeout_ms=0)
        self.assertEqual(blocked['code'], submit.PROMPT_RESEND_BLOCKED)
        self.assertEqual(self.page.evaluate('window.sends'), 1)

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
        self.assertIsNotNone(control.candidate(observer.ASSISTANT_CONNECTION_INTERRUPTED, accepted, details))
    def test_weak_connection_survives_reload_and_blocks_ready_until_absent(self):
        banner = '<div>Connection interrupted. ' + 'Waiting for response. ' * 12 + '</div>'
        self.route_body = document(banner=banner)
        self.set_html(self.route_body)
        control = transport.TransportControl(REQ, URL, 0, 60000, 20000, 1, monotonic=self.clock.now)
        accepted, evidence = observer.connection_interrupted(self.page)
        self.assertFalse(accepted)
        self.assertEqual(evidence['confidence'], 'weak')
        self.assertIsNotNone(control.candidate(observer.ASSISTANT_CONNECTION_INTERRUPTED, accepted, evidence))
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
    def send_natural(self, *, slot=1, binding=None, anchor=PROMPT, original=PROMPT):
        intent = transport.make_intent(self.page, REQ, URL, original, anchor,
                                      slot=slot, anchor_binding=binding, randrange=lambda _: 7)
        self.assertEqual(intent['promptSha256'], submit.prompt_sha256(intent['exactPromptText']))
        result = reminders.submit_reminder(self.page, intent['exactPromptText'], URL,
            timeout_ms=1000, anchor_prompt=anchor, anchor_binding=binding,
            control_intent=intent, sleep=self.clock.sleep,
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
    def test_artifact_pressable_aria_link_matches_production_dom(self):
        # Live REQ_20261008T045856Z_4237 renders a pressable span, not a[href].
        for role, expected in ((' role="link"', artifact.ARTIFACT_DOM_CONFIRMED),
                               ('', artifact.ARTIFACT_ATTACHMENT_NOT_FOUND)):
            with self.subTest(role=role):
                control = (f'<span data-d-component="pressable"{role} tabindex="0" '
                           f'aria-label="Open {FILENAME}"><span data-d-component="text">'
                           f'<span data-d-text-decoration="underline-dotted">{FILENAME}</span>'
                           '</span></span>')
                body = ('<p>' + html.escape(artifact.result_begin_marker(REQ)) + '</p>'
                        + control + '<p>' + html.escape(artifact.result_end_marker(REQ)) + '</p>')
                self.set_html(document(turns=group(body=final(body))))
                proof = observer.observe_next_assistant(self.page, PROMPT, URL,
                    timeout_ms=6000, stable_ms=0, sleep=self.clock.sleep, monotonic=self.clock.now)
                proof = bridge_module._attach_submit_proof(proof, prompt=PROMPT,
                    submitted={'code': submit.PROMPT_SEND_CONFIRMED, 'sendState': submit.PROVEN_SENT})
                found = artifact.detect_artifact_dom(self.page, expected_prompt=PROMPT,
                    expected_chat_url=URL, request_id=REQ, expected_filename=FILENAME,
                    completed_observer_result=proof)
                self.assertEqual(found['code'], expected, found)
                if found['ok']:
                    self.assertEqual(found['details']['attachment']['tag'], 'span')
                    self.assertEqual(found['details']['attachment']['role'], 'link')
                    identity = artifact_download._p5_identity(found)
                    resolved = artifact_download._resolve_control(self.page, identity)
                    self.assertEqual(resolved.get_attribute('role'), 'link')
                    self.assertTrue(artifact_download._control_snapshot(resolved, FILENAME)['visibleLabelExact'])
                self.assertIsNone(self.page.evaluate('window.sends'))

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

    def test_natural_launch_send_control_result_preserves_exact_original_lineage(self):
        import copy
        from launch_prompts import LAUNCH_PHRASES, build_launch_prompt
        task_url = 'https://example.test/tasks/' + REQ + '.md'
        launch = build_launch_prompt(REQ, task_url)
        self.set_html(document(turns=group(prompt='Earlier unrelated task',
            body=final('<p>Earlier answer</p>'), key='earlier')))
        launched = submit.submit_existing_prompt(self.page, launch, URL,
                                                 timeout_ms=1000, navigate=False)
        self.assertTrue(launched['ok'], launched)
        self.assertTrue(launched['details']['exactUserTurn'])
        self.assertFalse(launched['details']['requestKeyUserTurn'])
        self.assertEqual(launched['details']['promptSha256'], submit.prompt_sha256(launch))
        self.page.locator('[data-turn-key]').last.evaluate(
            '(el, body)=>el.insertAdjacentHTML("beforeend", body)', ACTIVITY)
        intent, sent, binding = self.send_natural(anchor=launch, original=launch)
        self.assertEqual(intent['originalUserOrdinal'], 1)
        self.assertEqual(intent['expectedUserTurnRelation']['precedingUserHashes'][1],
                         submit.prompt_sha256(launch))
        self.page.locator('[data-turn-key]').last.evaluate(
            '(el, body)=>el.insertAdjacentHTML("beforeend", body)', final(self.envelope()))
        proof = observer.observe_next_assistant(self.page, intent['exactPromptText'], URL,
            anchor_binding=binding, timeout_ms=6000, stable_ms=0,
            sleep=self.clock.sleep, monotonic=self.clock.now)
        proof = bridge_module._attach_submit_proof(proof, prompt=intent['exactPromptText'], submitted=sent)
        proof['details'].update(controlIntent=intent, anchorBinding=binding)
        def detect(candidate=proof):
            return artifact.detect_artifact_dom(self.page, expected_prompt=intent['exactPromptText'],
                expected_chat_url=URL, request_id=REQ, expected_filename=FILENAME,
                completed_observer_result=candidate)
        self.assertTrue(detect()['ok'])
        original = self.page.locator('[data-user-message-bubble]').nth(1)
        for changed in (LAUNCH_PHRASES[(LAUNCH_PHRASES.index(launch.splitlines()[0]) + 1) % 50] + '\n' + task_url,
                        launch.replace('/tasks/', '/altered/'),
                        launch.replace(REQ, 'REQ_20261001T041338Z_9999')):
            with self.subTest(changed=changed):
                original.evaluate('(el, text)=>el.textContent=text', changed)
                rejected = detect()
                self.assertFalse(rejected['ok'])
                self.assertEqual(rejected['details']['reason'], 'control_original_lineage_missing')
        # Even a matching visible hash cannot bind a foreign REQ as the original task.
        altered_proof = copy.deepcopy(proof)
        altered_proof['details']['controlIntent']['expectedUserTurnRelation']['precedingUserHashes'][1] = submit.prompt_sha256(changed)
        altered_proof['details']['anchorBinding']['precedingUserHashes'][1] = submit.prompt_sha256(changed)
        self.assertEqual(detect(altered_proof)['details']['reason'], 'control_original_lineage_missing')
        original.evaluate('(el, text)=>el.textContent=text', launch)
        for ordinal in (None, -1, 99):
            altered_proof = copy.deepcopy(proof)
            altered_proof['details']['controlIntent']['originalUserOrdinal'] = ordinal
            self.assertFalse(detect(altered_proof)['ok'])
        self.assertTrue(detect()['ok'])
        self.assertEqual(self.page.evaluate('window.sends'), 2)

    def run_bridge(self, *, timeout_ms=60000, interval_ms=20000, count=1, sleep=None):
        page = self.page
        class Context:
            def new_page(self): return page
        class Chromium:
            def connect_over_cdp(self, _url, **kwargs):
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
            with patch.object(page, 'close'), patch.object(submit, 'submit_fresh_prompt', side_effect=submitted) as initial_send:
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

    def test_additional_processing_has_no_stop_reload_or_extra_send(self):
        self.set_html(document(banner='<div role="status">Additional processing</div>', stop=True))
        with patch.object(self.page, 'reload', wraps=self.page.reload) as reload:
            result, state = self.run_bridge(timeout_ms=3000, count=0)
        self.assertFalse(result['ok'])
        self.assertEqual(state['phase'], 'TIMEOUT')
        self.assertEqual(reload.call_count, 0)
        self.assertIsNone(self.page.evaluate('window.sends'))
        self.assertEqual(self.page.evaluate('window.stops || 0'), 0)

    def test_connection_reload_is_once_and_does_not_send_continuation(self):
        banner = '<div role="alert">Connection interrupted</div>'
        self.set_html(document(banner=banner))
        self.route_body = document(banner=banner)
        with patch.object(self.page, 'reload', wraps=self.page.reload) as reload:
            result, state = self.run_bridge(timeout_ms=3000, count=0)
        self.assertFalse(result['ok'])
        self.assertEqual(reload.call_count, 1)
        self.assertIsNone(self.page.evaluate('window.sends'))
        self.assertLessEqual(self.clock.value, 48)
        self.assertNotIn('SYSTEM_CONTINUE', [e.get('phase') for e in state['transportEventJournal']])

    def test_connection_reload_failure_is_nonfatal_and_slots_are_not_consumed(self):
        self.set_html(document(banner='<div role="alert">Connection interrupted</div>'))
        with patch.object(self.page, 'reload', side_effect=RuntimeError('fixture reload failure')) as reload:
            result, state = self.run_bridge(timeout_ms=3000, interval_ms=2000, count=1)
        self.assertFalse(result['ok'])
        self.assertEqual(reload.call_count, 1)
        self.assertEqual(state['phase'], 'TIMEOUT')
        self.assertNotIn('CONSUMED_BY_RECOVERY', [s['status'] for s in state['reminderSlots']])

    def test_unknown_reminder_click_is_never_retried(self):
        self.set_html(document())
        real_click = Locator.click
        clicks = []
        def click(locator, *args, **kwargs):
            if locator.get_attribute('data-testid') == 'send-button':
                clicks.append(locator)
                real_click(locator, *args, **kwargs)
                raise RuntimeError('click response lost')
            return real_click(locator, *args, **kwargs)
        with patch.object(Locator, 'click', new=click):
            result, state = self.run_bridge(timeout_ms=60000, interval_ms=2000, count=2)
        self.assertFalse(result['ok'])
        self.assertEqual(len(clicks), 1)
        self.assertTrue(state['unresolvedSendUnknown'])

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
