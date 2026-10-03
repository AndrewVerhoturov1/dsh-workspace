import sys,unittest
from pathlib import Path
from contextlib import nullcontext
from unittest.mock import MagicMock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from test_browser_submit import FakePage
import browser_submit as s
import input_attachment as a

class TransactionTests(unittest.TestCase):
    def setUp(self):
        lock = patch.object(s.process_lock, "lock_browser_presend", side_effect=lambda **kw: nullcontext())
        lock.start()
        self.addCleanup(lock.stop)

    def run_failure(self,page,prompt,*,sent=False,exception=False,url_change=False,foreign=False):
        @s._presend_transaction
        def flow(page,prompt):
            transaction=page._postman_presend
            transaction.update(fillAttempted=True,ownedUrl=page.url,userCount=0)
            page.composer_text='foreign draft' if foreign else prompt
            if url_change:page.url='https://chatgpt.com/c/foreign'
            if sent:transaction['sendAttempted']=True
            if exception:raise RuntimeError('test')
            return s._result(s.PROMPT_SEND_UNKNOWN if sent else s.SEND_CONTROL_NOT_FOUND,
                ok=False,send_state=s.SEND_UNKNOWN if sent else s.SEND_PROVEN_NOT_SENT,transitions=[])
        return flow(page,prompt)
    def test_exact_proven_not_sent_cleared(self):
        p=FakePage();r=self.run_failure(p,'own prompt')
        self.assertEqual(p.composer_text,'');self.assertTrue(r['details']['unsentPromptCleared'])
    def test_unknown_never_clears_and_no_resend(self):
        p=FakePage();r=self.run_failure(p,'own prompt',sent=True)
        self.assertEqual(r['sendState'],s.SEND_UNKNOWN);self.assertEqual(p.composer_text,'own prompt');self.assertEqual(p.click_count,0)
    def test_foreign_text_never_cleared(self):
        p=FakePage();r=self.run_failure(p,'own prompt',foreign=True)
        self.assertEqual(p.composer_text,'foreign draft');self.assertFalse(r['details']['unsentPromptCleared'])
    def test_changed_url_never_cleared(self):
        p=FakePage();r=self.run_failure(p,'own prompt',url_change=True)
        self.assertEqual(p.composer_text,'own prompt');self.assertFalse(r['details']['unsentPromptCleared'])
    def test_exception_before_send_cleared(self):
        p=FakePage();r=self.run_failure(p,'own prompt',exception=True)
        self.assertEqual(r['sendState'],s.SEND_PROVEN_NOT_SENT);self.assertEqual(p.composer_text,'')
    def test_exception_after_attempt_is_unknown_no_cleanup(self):
        p=FakePage();r=self.run_failure(p,'own prompt',sent=True,exception=True)
        self.assertEqual(r['sendState'],s.SEND_UNKNOWN);self.assertEqual(p.composer_text,'own prompt')
    def test_preexisting_draft_never_filled(self):
        p=FakePage();p.composer_text='user draft'
        result=s.insert_prompt(p,p.locator('#prompt-textarea'),'own prompt',timeout_ms=0)
        self.assertEqual(result['code'],s.COMPOSER_NOT_EMPTY);self.assertEqual(p.composer_text,'user draft')
    def test_local_sent_image_rebind_requires_exact_ownership(self):
        proof={'sentAttachment':{'reason':'uploaded_source_unbound','duplicateSource':False,
              'observedImageSource':'uploaded','observedConversationId':'local-chatgpt:test'},
              'exactUserTurn':True,'composerEmpty':True,'chatUrlBound':True,'chatUrl':'https://chatgpt.com/c/test'}
        self.assertTrue(s._needs_sent_image_rebind(proof,proof['chatUrl']))
        self.assertFalse(s._needs_sent_image_rebind(proof,'https://chatgpt.com/c/foreign'))
        proof['exactUserTurn']=False
        self.assertFalse(s._needs_sent_image_rebind(proof,proof['chatUrl']))
    def test_attachment_cleanup_only_after_owned_not_sent_text_clear(self):
        attachment = object()
        page = FakePage()

        @s._presend_transaction
        def flow(page, prompt):
            page._postman_presend.update(
                fillAttempted=True, ownedUrl=page.url, userCount=0,
                attachment=attachment,
            )
            page.composer_text = prompt
            return s._result(s.SEND_CONTROL_NOT_FOUND, ok=False,
                             send_state=s.SEND_PROVEN_NOT_SENT, transitions=[])

        with patch.object(a, 'clear_owned', return_value={'cleared': True}) as clear:
            result = flow(page, 'own prompt')
        self.assertEqual(page.composer_text, '')
        clear.assert_called_once_with(page, attachment)
        self.assertTrue(result['details']['unsentAttachmentCleanup']['cleared'])

    def test_attachment_cleanup_skips_unknown_and_foreign_draft(self):
        for attempted, draft in [(True, 'own prompt'), (False, 'foreign draft')]:
            with self.subTest(attempted=attempted):
                page = FakePage()

                @s._presend_transaction
                def flow(page, prompt):
                    page._postman_presend.update(
                        fillAttempted=True, ownedUrl=page.url, userCount=0,
                        attachment=object(), sendAttempted=attempted,
                    )
                    page.composer_text = draft
                    return s._result(s.PROMPT_SEND_UNKNOWN if attempted else s.PROMPT_MISMATCH,
                                     ok=False, send_state=s.SEND_UNKNOWN if attempted else s.SEND_PROVEN_NOT_SENT,
                                     transitions=[])

                with patch.object(a, 'clear_owned') as clear:
                    flow(page, 'own prompt')
                clear.assert_not_called()
                self.assertEqual(page.composer_text, draft)

    def test_attachment_remove_exact_control_and_empty_proof(self):
        attachment = MagicMock(name='attachment')
        attachment.name = 'POSTMAN_REFERENCE_REQ_test.png'
        scope = MagicMock()
        controls = MagicMock()
        controls.count.return_value = 1
        control = controls.nth.return_value
        control.get_attribute.return_value = 'Remove ' + attachment.name
        images = MagicMock()
        images.count.return_value = 1
        scope.locator.side_effect = [controls, images]
        ready = {'known': True, 'count': 1, 'names': [attachment.name],
                 'pending': False, 'error': False, 'settled': True}
        with patch.object(s, 'find_composer', return_value=(object(), 'composer')), \
             patch.object(a, 'composer_scope', return_value=scope), \
             patch.object(a, 'snapshot', side_effect=[ready, {'known': True, 'count': 0}]):
            self.assertTrue(a.clear_owned(object(), attachment)['cleared'])
        images.nth.return_value.hover.assert_called_once_with(timeout=2000)
        control.click.assert_called_once_with(timeout=3000)

    def test_attachment_remove_refuses_foreign_or_unsettled_surface(self):
        attachment = MagicMock()
        attachment.name = 'own.png'
        for proof in [{'known': False}, {'known': True, 'count': 2},
                      {'known': True, 'count': 1, 'names': ['foreign.png']},
                      {'known': True, 'count': 1, 'names': ['own.png'], 'pending': True}]:
            scope = MagicMock()
            with patch.object(s, 'find_composer', return_value=(object(), 'composer')), \
                 patch.object(a, 'composer_scope', return_value=scope), \
                 patch.object(a, 'snapshot', return_value=proof):
                self.assertFalse(a.clear_owned(object(), attachment)['cleared'])
            scope.locator.assert_not_called()

    def test_exception_diagnostic_contains_no_private_message(self):
        class Root:
            def evaluate(self,*args):raise RuntimeError('strict mode violation: PRIVATE_FILE_CONTENT')
        result=a.snapshot(Root(),'test.png')
        self.assertEqual(result['exceptionCategory'],'ambiguous_locator')
        self.assertNotIn('PRIVATE',str(result))

if __name__=='__main__':unittest.main()
