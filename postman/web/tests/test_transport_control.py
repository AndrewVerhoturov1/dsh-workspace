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
    def test_continuous_banner_handled_once_disappearance_rearms(self):
        event = self.candidate()
        self.assertTrue(self.control.begin_recovery(SIGNAL, event))
        self.assertIsNone(self.candidate())
        self.control.finish_recovery('ready')
        for _ in range(20):
            self.assertIsNone(self.candidate())
        self.candidate(False)
        second = self.candidate()
        self.assertNotEqual(second, event)
        self.assertTrue(self.control.begin_recovery(SIGNAL, second))
    def test_no_small_request_wide_cap_for_genuine_new_episodes(self):
        for i in range(12):
            self.candidate(False)
            event = self.candidate()
            self.assertTrue(self.control.begin_recovery(SIGNAL, event))
            self.control.finish_recovery('ready')
        self.assertEqual(self.control.banners[SIGNAL]['number'], 12)
    def test_other_signal_cannot_start_independent_active_flow(self):
        self.control.begin_recovery(SIGNAL, self.candidate())
        self.assertFalse(self.control.begin_recovery(observer.ASSISTANT_CONNECTION_INTERRUPTED, 'other'))
        self.assertIsNone(self.control.candidate(observer.ASSISTANT_CONNECTION_INTERRUPTED, True,
                                                {'matchedText': 'Connection interrupted', 'candidateCount': 1}))
        self.assertEqual(self.control.active['kind'], SIGNAL)
        self.assertEqual(self.control.journal[-1]['event'], 'SYSTEM_SIGNAL_DEFERRED')
    def test_deferred_confirmation_keeps_time_but_starts_only_after_release(self):
        self.t = 3590
        current = self.candidate()
        self.control.begin_recovery(SIGNAL, current)
        connection = observer.ASSISTANT_CONNECTION_INTERRUPTED
        self.t = 3599.9
        self.assertIsNone(self.control.candidate(connection, True,
                                                {'matchedText': 'Connection interrupted', 'candidateCount': 1}))
        episode = self.control.banners[connection]
        deferred = episode['eventId']
        self.assertEqual(episode['eventConfirmedAt'], 3599.9)
        self.assertFalse(self.control.begin_recovery(connection, deferred))
        self.assertEqual(self.control.active['eventId'], current)
        self.t = 3600.1
        self.control.finish_recovery(connection, status='ABORTED', reason='serial_handoff')
        self.assertTrue(self.control.begin_recovery(connection, deferred))
        self.assertEqual(self.control.active['deadline'], 3645)
        terminal = next(e for e in self.control.journal if e['event'] == 'RECOVERY_ABORTED')
        started = self.control.journal[-1]
        self.assertEqual(started['event'], 'RECOVERY_STARTED')
        self.assertLess(terminal['sequence'], started['sequence'])
        self.assertEqual(self.control.soft_deadline, 3600)

    def test_deferred_weak_signal_requires_second_poll_and_absence_rearms(self):
        self.control.begin_recovery(SIGNAL, self.candidate())
        connection = observer.ASSISTANT_CONNECTION_INTERRUPTED
        evidence = {'candidateCount': 1, 'matchedText': 'Connection interrupted', 'confidence': 'weak'}
        self.t = 20
        self.assertIsNone(self.control.candidate(connection, False, evidence))
        episode = self.control.banners[connection]
        self.assertFalse(episode['confirmed'])
        self.t = 21
        self.assertIsNone(self.control.candidate(connection, False, evidence))
        self.assertTrue(episode['confirmed'])
        self.assertEqual(episode['eventConfirmedAt'], 21)
        self.assertFalse(self.control.begin_recovery(connection, episode['eventId']))
        self.control.candidate(connection, False, {})
        self.control.finish_recovery('ready')
        self.assertFalse(self.control.begin_recovery(connection, episode['eventId']))
        self.assertIsNone(self.control.candidate(connection, False, evidence))
        self.t = 22
        next_event = self.control.candidate(connection, False, evidence)
        self.assertTrue(self.control.begin_recovery(connection, next_event))
        self.assertEqual(episode['number'], 2)

    def test_recovery_crosses_one_checkpoint_and_future_slots_remain(self):
        self.control.slot_status(1, 'SENT')
        self.t = 19*60 + 58
        self.control.begin_recovery(SIGNAL, self.candidate())
        self.t = 20*60 + 20
        self.control.finish_recovery('ready')
        self.assertEqual([s['status'] for s in self.control.slots],
                         ['SENT', 'CONSUMED_BY_RECOVERY', 'PENDING', 'PENDING', 'PENDING'])
    def test_recovery_consumes_all_crossed_and_already_overdue_slots(self):
        self.t = 19*60 + 50
        self.control.begin_recovery(SIGNAL, self.candidate())
        self.t = 30*60 + 10
        self.control.finish_recovery('ready')
        self.assertEqual([s['status'] for s in self.control.slots],
                         ['CONSUMED_BY_RECOVERY']*3 + ['PENDING']*2)
        self.control.slot_status(4, 'SENT')
        self.control.slot_status(5, 'SENT')
        self.assertEqual([s['scheduledElapsedMs'] for s in self.control.slots],
                         [600000,1200000,1800000,2400000,3000000])
    def test_soft_deadline_does_not_grant_new_recovery(self):
        self.t = 3600
        self.assertIsNone(self.candidate())
        self.assertFalse(self.control.begin_recovery(SIGNAL, 'late'))
    def test_only_current_cycle_has_bounded_grace(self):
        self.t = 3598
        self.control.begin_recovery(SIGNAL, self.candidate())
        self.assertEqual(self.control.recovery_remaining_ms(), 47000)
        self.t = 3601
        self.assertEqual(self.control.recovery_remaining_ms(), 44000)
        self.assertFalse(self.control.begin_recovery(SIGNAL, 'late'))
        self.t = 3645
        self.assertEqual(self.control.recovery_remaining_ms(), 0)
        self.control.finish_recovery('timeout', status='ABORTED')
        self.candidate(False)
        self.assertIsNone(self.candidate())
        self.assertFalse(self.control.begin_recovery(SIGNAL, 'late'))
    def test_cycle_budget_and_grace_are_not_new_working_budget(self):
        self.t = 20
        self.control.begin_recovery(SIGNAL, self.candidate())
        self.assertEqual(self.control.recovery_remaining_ms(), 180000)
        self.t = 200
        self.assertEqual(self.control.recovery_remaining_ms(), 0)
        self.assertEqual(self.control.soft_deadline, 3600)
    def test_confirmation_time_not_outer_iteration_grants_grace(self):
        self.t = 3599.9
        event = self.candidate()
        self.t = 3600.1
        self.assertTrue(self.control.can_begin_recovery(SIGNAL, event))
        self.assertTrue(self.control.begin_recovery(SIGNAL, event))
        self.assertEqual(self.control.active['eventConfirmedAt'], 3599.9)
        self.assertEqual(self.control.active['deadline'], 3645)
        self.assertFalse(self.control.begin_recovery(SIGNAL, event))

    def test_pending_confirmation_cannot_start_beyond_hard_deadline(self):
        self.t = 3599.9
        event = self.candidate()
        self.t = 3645
        self.assertFalse(self.control.can_begin_recovery(SIGNAL, event))
        self.assertFalse(self.control.begin_recovery(SIGNAL, event))

    def test_failed_and_aborted_recovery_never_record_completion(self):
        for status in ('FAILED', 'ABORTED'):
            self.candidate(False)
            event = self.candidate()
            self.control.begin_recovery(SIGNAL, event)
            self.control.finish_recovery('reason', status=status, code='transport_code')
            self.control.finish_recovery('duplicate cleanup', status=status)
            terminal = [e for e in self.control.journal if e.get('eventId') == event
                        and e['event'] in ('RECOVERY_COMPLETED', 'RECOVERY_FAILED', 'RECOVERY_ABORTED')]
            self.assertEqual(len(terminal), 1)
            self.assertEqual(terminal[0]['event'], 'RECOVERY_' + status)
            self.assertEqual(terminal[0]['code'], 'transport_code')

    def test_passive_connection_waiting_preserves_soft_time_and_consumes_slots(self):
        self.t = 100
        event = self.candidate()
        self.control.begin_recovery(SIGNAL, event)
        self.t = 110
        self.control.wait_for_connection('exhausted')
        self.assertEqual(self.control.phase, 'CONNECTION_WAITING')
        self.assertEqual(self.control.active['deadline'], self.control.soft_deadline)
        self.t = 1200
        self.control.consume_slots()
        self.assertEqual([s['status'] for s in self.control.slots],
                         ['CONSUMED_BY_RECOVERY'] * 2 + ['PENDING'] * 3)
        self.assertIsNone(self.candidate())
        self.assertFalse(self.control.begin_recovery(SIGNAL, event))

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
    def test_rejected_candidate_records_why_and_no_candidate_has_distinct_count(self):
        self.control.candidate(SIGNAL, False, {'candidateCount': 1, 'matchedText': 'quoted',
            'confidence': 'rejected', 'reason': 'transcript_or_literal_quote', 'evidence': {'insideMarkdown':True}})
        self.control.candidate(SIGNAL, False, {})
        diagnostic = self.control.diagnostics[SIGNAL]
        self.assertEqual(diagnostic['candidateSeenCount'], 1)
        self.assertEqual(diagnostic['pollCount'], 2)
        self.assertEqual(diagnostic['lastRejectReason'], 'transcript_or_literal_quote')
        self.assertEqual(diagnostic['confirmedCount'], 0)


if __name__ == '__main__':
    unittest.main()
