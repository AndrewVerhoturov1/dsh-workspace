"""Explicit UNKNOWN recovery must never upload/fill/resend the image turn."""
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import web_worker_bridge as worker

REQ = 'REQ_20261002T181426Z_8935'
URL = 'https://chatgpt.com/c/resume-fixture'

class ImageResumeTests(unittest.TestCase):
    def test_resume_reproves_without_initial_send_and_rejects_bad_binding(self):
        attachment = SimpleNamespace(request_id=REQ, media_type='image/png', metadata=lambda: {'requestId':REQ})
        existing = {'exactPromptText':'exact prompt','failureDetails':{
            'code':'PROMPT_SEND_UNKNOWN','sendState':'UNKNOWN','details':{
                'chatUrl':URL,'exactUserTurn':True,'userTurnCountBefore':0,'userTurnCountNow':1,
                'inputBundle':attachment.metadata()}}}
        page = SimpleNamespace(close=lambda:None)
        class Factory:
            def __enter__(self): self.chromium=self; return self
            def __exit__(self,*a): pass
            def connect_over_cdp(self,*a,**kw): return self
            @property
            def contexts(self): return [self]
            def new_page(self): return page
        with tempfile.TemporaryDirectory() as tmp:
            bridge=worker.WebWorkerBridge(root=Path(tmp),result_root=Path(tmp)/'results')
            with patch.object(bridge,'read_state',return_value=existing), \
                 patch.object(worker.browser_submit,'prepare_existing_chat',return_value={'ok':True}) as prep, \
                 patch.object(worker.browser_submit,'_observe_send_proof',return_value=(True,{
                     'chatUrl':URL,'sentAttachmentConfirmed':True})) as proof, \
                 patch.object(worker.browser_submit,'submit_fresh_prompt',side_effect=AssertionError('resend')) as fresh, \
                 patch.object(worker.browser_submit,'submit_existing_prompt',side_effect=AssertionError('send')) as send, \
                 patch.object(worker.browser_observer,'connection_interrupted',return_value=(False,{})), \
                 patch.object(worker.browser_observer,'additional_processing',return_value=(False,{})), \
                 patch.object(worker.browser_observer,'observe_next_assistant',side_effect=RuntimeError('observation sentinel')) as observe:
                args=dict(task_url='',prompt='exact prompt',expected_filename='result.zip',expected_request={'requestId':REQ},
                    conversation_url=URL,input_attachment=attachment,image_prepare=lambda:None,
                    resume_image=True,playwright_factory=Factory)
                result=bridge.run_request(REQ,**args)
                self.assertIn('observation sentinel',str(result))
                prep.assert_called_once()
                proof.assert_called_once()
                observe.assert_called_once()
                fresh.assert_not_called();send.assert_not_called()
                existing['failureDetails']['details']['chatUrl']='https://chatgpt.com/c/other'
                result=bridge.run_request(REQ,**args)
                self.assertEqual(result['details']['reason'],'image_resume_binding_invalid')
                fresh.assert_not_called();send.assert_not_called()
