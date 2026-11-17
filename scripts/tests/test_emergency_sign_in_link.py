import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from contextlib import redirect_stderr, redirect_stdout
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location("emergency", Path(__file__).parents[1] / "emergency-sign-in-link.py")
emergency = importlib.util.module_from_spec(spec)
spec.loader.exec_module(emergency)

KEY = "synthetic-service-role-key"
USER_ID = "00000000-0000-4000-8000-000000000001"
ARGS = [
    "--supabase-url", "https://project.supabase.example",
    "--app-url", "https://mgm.example.org",
    "--email", " Admin@Example.org ",
    "--requested-by", "Admin, confirmed by phone",
    "--reason", "mail server down",
]


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def supabase(roles=({"role": "super_admin"},), user_id=USER_ID, token="hashed-token"):
    """A fake urlopen answering the three calls the script makes."""
    calls = []

    def urlopen(request, timeout):
        calls.append(request)
        path = request.full_url
        if path.endswith("/rest/v1/rpc/fn_auth_sign_in_target"):
            body = user_id
        elif "/rest/v1/user_roles?" in path:
            body = list(roles)
        elif path.endswith("/auth/v1/admin/generate_link"):
            body = {"hashed_token": token} if token else {}
        else:
            raise AssertionError(path)
        return FakeResponse(json.dumps(body).encode())

    return urlopen, calls


class EmergencySignInLinkTests(unittest.TestCase):
    def run_cli(self, urlopen, args=ARGS, env=None):
        out, err = io.StringIO(), io.StringIO()
        with patch.dict("os.environ", env if env is not None else {"SUPABASE_SERVICE_ROLE_KEY": KEY}, clear=True), \
             patch.object(emergency, "urlopen", urlopen), \
             patch.object(emergency.getpass, "getuser", return_value="operator"), \
             redirect_stdout(out), redirect_stderr(err):
            result = emergency.main(args)
        return result, out.getvalue(), err.getvalue()

    def test_prints_only_the_link_on_stdout_and_the_record_on_stderr(self):
        urlopen, calls = supabase()
        result, out, err = self.run_cli(urlopen)
        self.assertEqual(result, 0)
        self.assertEqual(out, "https://mgm.example.org/auth/confirm?token_hash=hashed-token\n")
        record = json.loads(err.splitlines()[1])
        self.assertEqual(record["event"], "auth.emergency_sign_in_link")
        self.assertEqual(record["email"], "admin@example.org")
        self.assertEqual(record["user_id"], USER_ID)
        self.assertEqual(record["requested_by"], "Admin, confirmed by phone")
        self.assertEqual(record["reason"], "mail server down")
        self.assertEqual(record["operator"], "operator")
        self.assertNotIn("hashed-token", err)
        self.assertNotIn(KEY, out + err)
        generate = calls[-1]
        self.assertEqual(json.loads(generate.data), {"type": "magiclink", "email": "admin@example.org"})
        self.assertEqual(generate.get_header("Apikey"), KEY)

    def test_refuses_an_address_without_a_role_before_making_a_token(self):
        urlopen, calls = supabase(user_id=None)
        result, out, err = self.run_cli(urlopen)
        self.assertEqual(result, 1)
        self.assertEqual(out, "")
        self.assertIn("no MGM role", err)
        self.assertEqual(len(calls), 1)

    def test_refuses_someone_who_is_not_a_super_admin(self):
        urlopen, calls = supabase(roles=())
        result, out, err = self.run_cli(urlopen)
        self.assertEqual(result, 1)
        self.assertEqual(out, "")
        self.assertIn("not a super admin", err)
        self.assertFalse(any(c.full_url.endswith("/generate_link") for c in calls))

    def test_reports_a_missing_token(self):
        urlopen, _ = supabase(token=None)
        result, out, err = self.run_cli(urlopen)
        self.assertEqual((result, out), (1, ""))
        self.assertIn("no token", err)

    def test_reports_an_http_error_by_status_only(self):
        def urlopen(request, timeout):
            raise HTTPError(request.full_url, 401, "Unauthorized", {}, io.BytesIO(KEY.encode()))

        result, out, err = self.run_cli(urlopen)
        self.assertEqual((result, out), (1, ""))
        self.assertIn("401", err)
        self.assertNotIn(KEY, err)

    def test_prompts_for_the_key_when_it_is_not_in_the_environment(self):
        urlopen, calls = supabase()
        with patch.object(emergency.getpass, "getpass", return_value=KEY) as prompt:
            result, _, _ = self.run_cli(urlopen, env={})
        self.assertEqual(result, 0)
        prompt.assert_called_once()
        self.assertEqual(calls[0].get_header("Apikey"), KEY)

    def test_refuses_an_app_url_that_is_not_an_https_origin(self):
        for app_url in ("http://mgm.example.org", "https://mgm.example.org/login", "https://u:p@mgm.example.org"):
            urlopen, calls = supabase()
            args = list(ARGS)
            args[args.index("--app-url") + 1] = app_url
            result, out, err = self.run_cli(urlopen, args=args)
            self.assertEqual((result, out), (1, ""), app_url)
            self.assertIn("--app-url", err)
            self.assertEqual(calls, [])

    def test_requires_who_asked_and_why(self):
        args = list(ARGS)
        args[args.index("--reason") + 1] = "  "
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            emergency.main(args)


if __name__ == "__main__":
    unittest.main()
