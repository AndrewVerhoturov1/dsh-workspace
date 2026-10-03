"""Serialized control, absolute slots, episode identity and deadline regressions."""
import sys
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parents[1]
if str(WEB) not in sys.path:
    sys.path.insert(0, str(WEB))
import browser_observer as observer
import transport_control as transport

REQ = 'REQ_20261001T041338Z_9561'
URL = 'https://chatgpt.com/c/control-fixture'
SIGNAL = observer.ADDITIONAL_PROCESSING


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.t = 0.0
        self.control = transport.TransportControl(REQ, URL, 0, 3600000, 600000, 5,
                                                 monotonic=lambda: self.t)
    def candidate(self, present=True):
        return self.control.candidate(SIGNAL, present,
                                      {'candidateCount': 1, 'matchedText': 'Наши системы…',
                                       'confidence': 'strong', 'evidence': {'roleStatus': True}} if present else {})
    def test_additional_processing_never_enters_recovery(self):
        self.assertIsNone(self.candidate())
        self.assertFalse(self.control.begin_recovery(SIGNAL, 'unused'))
        self.assertIsNone(self.control.active)

    def test_connection_banner_reloads_once_until_it_disappears(self):
        connection = observer.ASSISTANT_CONNECTION_INTERRUPTED
        event = self.control.candidate(connection, True, {'confidence': 'strong'})
        self.assertTrue(self.control.begin_recovery(connection, event))
        self.assertFalse(self.control.begin_recovery(connection, event))
        self.control.finish_recovery('ready')
        self.assertIsNone(self.control.candidate(connection, True, {}))
        self.control.candidate(connection, False, {})
        second = self.control.candidate(connection, True, {})
        self.assertNotEqual(second, event)
        self.assertTrue(self.control.begin_recovery(connection, second))

    def test_weak_connection_signal_is_best_effort_without_two_poll_gate(self):
        connection = observer.ASSISTANT_CONNECTION_INTERRUPTED
        event = self.control.candidate(connection, False, {'confidence': 'weak'})
        self.assertTrue(self.control.begin_recovery(connection, event))
        self.control.finish_recovery('not_ready')
        self.assertIsNone(self.control.candidate(connection, False, {'confidence': 'weak'}))

    def test_recovery_preserves_due_and_future_reminder_slots(self):
        self.control.slot_status(1, 'SENT')
        self.t = 1198
        connection = observer.ASSISTANT_CONNECTION_INTERRUPTED
        event = self.control.candidate(connection, True, {})
        self.control.begin_recovery(connection, event)
        self.t = 1220
        self.control.finish_recovery('ready')
        self.assertEqual([s['status'] for s in self.control.slots], ['SENT'] + ['PENDING'] * 4)
        self.assertEqual([s['scheduledElapsedMs'] for s in self.control.slots], [600000,1200000,1800000,2400000,3000000])

    def test_recovery_has_bounded_grace_without_new_working_budget(self):
        self.t = 3598
        connection = observer.ASSISTANT_CONNECTION_INTERRUPTED
        event = self.control.candidate(connection, True, {})
        self.assertTrue(self.control.begin_recovery(connection, event))
        self.assertEqual(self.control.recovery_remaining_ms(), 47000)
        self.t = 3645
        self.assertEqual(self.control.recovery_remaining_ms(), 0)
        self.control.finish_recovery('timeout')
        self.control.candidate(connection, False, {})
        self.assertIsNone(self.control.candidate(connection, True, {}))
        self.assertEqual(self.control.soft_deadline, 3600)

    def test_bounded_journal_preserves_append_values_sequence_and_diagnostics(self):
        fields = {'status': 'before'}
        self.control.event('PROOF', proof=fields)
        fields['status'] = 'after'
        self.assertEqual(self.control.journal[-1]['proof']['status'], 'before')
        for i in range(400):
            self.control.event('TEST', index=i)
        snapshot = self.control.snapshot()
        self.assertEqual(len(snapshot['transportEventJournal']), transport.JOURNAL_LIMIT)
        self.assertGreater(snapshot['journalDroppedCount'], 0)
        self.assertEqual(snapshot['transportEventJournal'][0]['event'], 'STAGE_STARTED')
        sequences = [e['sequence'] for e in snapshot['transportEventJournal']]
        self.assertEqual(sequences, sorted(set(sequences)))
        snapshot['reminderSlots'][0]['status'] = 'foreign'
        self.assertEqual(self.control.slots[0]['status'], 'PENDING')


if __name__ == '__main__':
    unittest.main()
