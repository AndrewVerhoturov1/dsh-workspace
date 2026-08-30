from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "browser_bootstrap.py"
spec = importlib.util.spec_from_file_location("browser_bootstrap", MODULE_PATH)
bootstrap = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bootstrap)


class FakeLocator:
    def __init__(self, *, count=0, visible=False, text=""):
        self._count = count
        self._visible = visible
        self._text = text
        self.last = self

    def count(self):
        return self._count

    def is_visible(self):
        return self._visible

    def inner_text(self, timeout=None):
        return self._text


class FakePage:
    def __init__(self, selectors=None, body_text="", url="https://chatgpt.com/", goto_error=None):
        self.selectors = selectors or {}
        self.body_text = body_text
        self.url = url
        self.goto_error = goto_error
        self.closed = False
        self.goto_calls = []

    def locator(self, selector):
        if selector == "body":
            return FakeLocator(count=1, visible=True, text=self.body_text)
        return self.selectors.get(selector, FakeLocator())

    def goto(self, url, wait_until=None, timeout=None):
        self.goto_calls.append((url, wait_until, timeout))
        if self.goto_error:
            raise RuntimeError(self.goto_error)
        self.url = url

    def close(self):
        self.closed = True


class FakeContext:
    def __init__(self, existing_pages=None, new_page=None):
        self.pages = list(existing_pages or [])
        self._new_page = new_page or FakePage()
        self.closed = False
        self.new_page_calls = 0

    def new_page(self):
        self.new_page_calls += 1
        self.pages.append(self._new_page)
        return self._new_page

    def close(self):
        self.closed = True


class FakeBrowser:
    def __init__(self, contexts=None, fallback_context=None):
        self.contexts = list(contexts or [])
        self.fallback_context = fallback_context or FakeContext()
        self.new_context_calls = 0
        self.close_calls = 0

    def new_context(self):
        self.new_context_calls += 1
        return self.fallback_context

    def close(self):
        self.close_calls += 1


class FakeChromium:
    def __init__(self, browser=None, error=None):
        self.browser = browser or FakeBrowser()
        self.error = error
        self.calls = []

    def connect_over_cdp(self, url):
        self.calls.append(url)
        if self.error:
            raise RuntimeError(self.error)
        return self.browser


class FakePlaywright:
    def __init__(self, chromium):
        self.chromium = chromium


class BrowserBootstrapTests(unittest.TestCase):
    def ready_page(self):
        return FakePage(selectors={"#prompt-textarea": FakeLocator(count=1, visible=True)})

    def test_default_profile_uses_localappdata(self):
        path = bootstrap.default_profile_dir({"LOCALAPPDATA": r"C:\\Users\\A\\AppData\\Local"})
        self.assertTrue(str(path).endswith(str(Path("DSH") / "Postman" / "browser-profile")))

    def test_profile_is_persistent_identity_while_pid_is_transient(self):
        identity = bootstrap.describe_browser_identity(
            r"C:\\Users\\A\\AppData\\Local\\DSH\\Postman\\browser-profile",
            4321,
        )
        self.assertEqual(identity["persistent"]["kind"], bootstrap.PROFILE_IDENTITY_KIND)
        self.assertTrue(identity["persistent"]["survivesChromeRestart"])
        self.assertTrue(identity["persistent"]["profileDir"].endswith("browser-profile"))
        self.assertEqual(identity["process"]["kind"], bootstrap.PROCESS_IDENTITY_KIND)
        self.assertEqual(identity["process"]["pid"], 4321)
        self.assertFalse(identity["process"]["survivesChromeRestart"])

    def test_main_launch_reports_profile_as_persistent_identity(self):
        class FakeProcess:
            pid = 4321

        output = io.StringIO()
        ready = bootstrap._result(bootstrap.BOOTSTRAP_READY, ok=True, details={})
        with (
            patch.object(bootstrap, "discover_chrome_executable", return_value=Path("chrome.exe")),
            patch.object(bootstrap, "start_dedicated_chrome", return_value=FakeProcess()),
            patch.object(bootstrap, "wait_for_cdp", return_value={}),
            patch.object(bootstrap, "run_live_probe", return_value=ready),
            redirect_stdout(output),
        ):
            exit_code = bootstrap.main([
                "--launch-chrome",
                "--profile-dir",
                r"C:\\Users\\A\\AppData\\Local\\DSH\\Postman\\browser-profile",
            ])

        payload = json.loads(output.getvalue())
        identity = payload["details"]["browserIdentity"]
        self.assertEqual(exit_code, 0)
        self.assertEqual(identity["persistent"]["kind"], bootstrap.PROFILE_IDENTITY_KIND)
        self.assertTrue(identity["persistent"]["survivesChromeRestart"])
        self.assertEqual(identity["process"]["pid"], 4321)
        self.assertFalse(identity["process"]["survivesChromeRestart"])

    def test_normalize_accepts_loopback_http(self):
        self.assertEqual(bootstrap.normalize_cdp_url("http://127.0.0.1:9222/"), "http://127.0.0.1:9222")

    def test_normalize_accepts_direct_localhost_ws(self):
        value = "ws://localhost:9222/devtools/browser/abc"
        self.assertEqual(bootstrap.normalize_cdp_url(value), value)

    def test_normalize_rejects_remote_endpoint_by_default(self):
        with self.assertRaises(bootstrap.BrowserBootstrapError) as ctx:
            bootstrap.normalize_cdp_url("http://10.0.0.2:9222")
        self.assertEqual(ctx.exception.code, bootstrap.BOOTSTRAP_INVALID_CONFIG)

    def test_normalize_can_explicitly_allow_remote_endpoint(self):
        self.assertEqual(
            bootstrap.normalize_cdp_url("http://10.0.0.2:9222", allow_remote=True),
            "http://10.0.0.2:9222",
        )

    def test_build_chrome_command_uses_dedicated_profile_and_loopback_cdp(self):
        command = bootstrap.build_chrome_command("chrome.exe", r"C:\\profile", port=9333)
        self.assertIn("--remote-debugging-port=9333", command)
        self.assertIn("--remote-debugging-address=127.0.0.1", command)
        self.assertTrue(any(item.startswith("--user-data-dir=") for item in command))
        self.assertEqual(command[-1], bootstrap.CHATGPT_URL)

    def test_build_chrome_command_rejects_invalid_port(self):
        with self.assertRaises(bootstrap.BrowserBootstrapError):
            bootstrap.build_chrome_command("chrome.exe", "profile", port=70000)

    def test_discover_chrome_prefers_explicit_existing_path(self):
        result = bootstrap.discover_chrome_executable(explicit="X:/Chrome/chrome.exe", exists=lambda p: True)
        self.assertEqual(result, Path("X:/Chrome/chrome.exe"))

    def test_discover_chrome_returns_none_for_missing_explicit_path(self):
        result = bootstrap.discover_chrome_executable(explicit="X:/missing.exe", exists=lambda p: False)
        self.assertIsNone(result)

    def test_find_visible_composer_prefers_specific_selector(self):
        page = FakePage(selectors={
            "#prompt-textarea": FakeLocator(count=1, visible=True),
            "textarea": FakeLocator(count=1, visible=True),
        })
        _, selector = bootstrap.find_visible_composer(page)
        self.assertEqual(selector, "#prompt-textarea")

    def test_classify_ready_wins_even_if_login_words_exist_elsewhere(self):
        page = self.ready_page()
        page.body_text = "Log in Sign up"
        code, details = bootstrap.classify_session(page)
        self.assertEqual(code, bootstrap.BOOTSTRAP_READY)
        self.assertEqual(details["composerSelector"], "#prompt-textarea")

    def test_classify_english_login_required(self):
        code, _ = bootstrap.classify_session(FakePage(body_text="Please Log in to continue"))
        self.assertEqual(code, bootstrap.BOOTSTRAP_LOGIN_REQUIRED)

    def test_classify_russian_login_required(self):
        code, _ = bootstrap.classify_session(FakePage(body_text="Войти или регистрация"))
        self.assertEqual(code, bootstrap.BOOTSTRAP_LOGIN_REQUIRED)

    def test_classify_unknown_without_composer(self):
        code, details = bootstrap.classify_session(FakePage(body_text="loading"))
        self.assertEqual(code, bootstrap.BOOTSTRAP_COMPOSER_NOT_FOUND)
        self.assertFalse(details["loginMarkerObserved"])

    def test_attach_creates_dedicated_page_and_preserves_existing_page(self):
        existing = FakePage(url="https://example.com")
        owned = self.ready_page()
        context = FakeContext(existing_pages=[existing], new_page=owned)
        browser = FakeBrowser(contexts=[context])
        playwright = FakePlaywright(FakeChromium(browser))
        result = bootstrap.attach_and_probe(playwright, "http://127.0.0.1:9222")
        self.assertTrue(result["ok"])
        self.assertEqual(result["code"], bootstrap.BOOTSTRAP_READY)
        self.assertEqual(result["details"]["existingPagesBefore"], 1)
        self.assertEqual(context.new_page_calls, 1)
        self.assertFalse(existing.closed)
        self.assertTrue(owned.closed)
        self.assertEqual(browser.close_calls, 0)

    def test_attach_can_keep_owned_page_open(self):
        owned = self.ready_page()
        context = FakeContext(new_page=owned)
        browser = FakeBrowser(contexts=[context])
        result = bootstrap.attach_and_probe(
            FakePlaywright(FakeChromium(browser)),
            "http://127.0.0.1:9222",
            close_owned_page=False,
        )
        self.assertTrue(result["ok"])
        self.assertFalse(owned.closed)
        self.assertFalse(context.closed)
        self.assertEqual(browser.close_calls, 0)

    def test_attach_creates_and_may_close_only_owned_context_when_none_exists(self):
        owned = self.ready_page()
        fallback = FakeContext(new_page=owned)
        browser = FakeBrowser(contexts=[], fallback_context=fallback)
        result = bootstrap.attach_and_probe(FakePlaywright(FakeChromium(browser)), "http://localhost:9222")
        self.assertTrue(result["ok"])
        self.assertTrue(result["details"]["ownsContext"])
        self.assertEqual(browser.new_context_calls, 1)
        self.assertTrue(fallback.closed)
        self.assertEqual(browser.close_calls, 0)

    def test_attach_failure_is_recoverable_and_fail_closed(self):
        result = bootstrap.attach_and_probe(
            FakePlaywright(FakeChromium(error="connection refused")),
            "http://127.0.0.1:9222",
        )
        self.assertFalse(result["ok"])
        self.assertTrue(result["recoverable"])
        self.assertEqual(result["code"], bootstrap.BOOTSTRAP_ATTACH_FAILED)

    def test_navigation_failure_is_recoverable_and_owned_page_is_closed(self):
        owned = FakePage(goto_error="navigation failed")
        context = FakeContext(new_page=owned)
        browser = FakeBrowser(contexts=[context])
        result = bootstrap.attach_and_probe(FakePlaywright(FakeChromium(browser)), "http://127.0.0.1:9222")
        self.assertEqual(result["code"], bootstrap.BOOTSTRAP_NAVIGATION_FAILED)
        self.assertTrue(owned.closed)
        self.assertEqual(browser.close_calls, 0)

    def test_login_required_never_becomes_success(self):
        owned = FakePage(body_text="Log in")
        context = FakeContext(new_page=owned)
        result = bootstrap.attach_and_probe(
            FakePlaywright(FakeChromium(FakeBrowser(contexts=[context]))),
            "http://127.0.0.1:9222",
            timeout_ms=0,
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], bootstrap.BOOTSTRAP_LOGIN_REQUIRED)
        self.assertTrue(result["recoverable"])

    def test_missing_composer_times_out_fail_closed(self):
        owned = FakePage(body_text="still loading")
        context = FakeContext(new_page=owned)
        result = bootstrap.attach_and_probe(
            FakePlaywright(FakeChromium(FakeBrowser(contexts=[context]))),
            "http://127.0.0.1:9222",
            timeout_ms=0,
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], bootstrap.BOOTSTRAP_COMPOSER_NOT_FOUND)

    def test_wait_for_cdp_direct_ws_needs_no_http_fetch(self):
        calls = []
        result = bootstrap.wait_for_cdp(
            "ws://localhost:9222/devtools/browser/abc",
            fetch_json=lambda *_: calls.append(1),
        )
        self.assertEqual(result["source"], "direct_ws")
        self.assertEqual(calls, [])

    def test_wait_for_cdp_reads_json_version(self):
        result = bootstrap.wait_for_cdp(
            "http://127.0.0.1:9222",
            timeout_s=0,
            fetch_json=lambda url, timeout: {"webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/abc"},
        )
        self.assertEqual(result["source"], "json_version")
        self.assertTrue(result["webSocketDebuggerUrl"].startswith("ws://"))

    def test_wait_for_cdp_timeout_has_machine_readable_code(self):
        clock = iter([0.0, 1.0])
        with self.assertRaises(bootstrap.BrowserBootstrapError) as ctx:
            bootstrap.wait_for_cdp(
                "http://127.0.0.1:9222",
                timeout_s=0.5,
                fetch_json=lambda *_: (_ for _ in ()).throw(OSError("refused")),
                sleep=lambda _: None,
                monotonic=lambda: next(clock),
            )
        self.assertEqual(ctx.exception.code, bootstrap.BOOTSTRAP_CDP_UNREACHABLE)
        self.assertTrue(ctx.exception.recoverable)

    def test_result_is_json_serializable(self):
        page = self.ready_page()
        context = FakeContext(new_page=page)
        result = bootstrap.attach_and_probe(
            FakePlaywright(FakeChromium(FakeBrowser(contexts=[context]))),
            "http://127.0.0.1:9222",
        )
        json.dumps(result)

    def test_module_contains_no_prompt_send_api(self):
        forbidden = {"send_prompt", "download_artifact", "submit_prompt"}
        self.assertTrue(forbidden.isdisjoint(set(dir(bootstrap))))


if __name__ == "__main__":
    unittest.main()
