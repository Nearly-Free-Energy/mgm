#!/usr/bin/env python3
"""Emergency sign-in link for a super admin, when MGM cannot email one.

docs/runbooks/emergency-sign-in.md says when to use it and how to hand the
link over and record it. It asks Supabase Auth for a one-time sign-in token
(the same generateLink call /api/auth/sign-in-link makes) and prints the
link; it sends no email. It refuses an address without a super_admin role,
so it never creates an account.

The link goes to standard output, alone, so it can be piped; the record to
file goes to standard error. The service-role key is read from
SUPABASE_SERVICE_ROLE_KEY or a hidden prompt, never from arguments.
"""
import argparse
from datetime import datetime, timezone
import getpass
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen

LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
TIMEOUT_SECONDS = 15
# How long the link works: Supabase's email OTP expiry
# (src/lib/auth/sign-in-link.ts, SIGN_IN_LINK_MINUTES). If that changes, change this.
LINK_MINUTES = 15


class Refused(Exception):
    pass


def origin(value, name):
    """The URL's origin; https unless the host is loopback, and no path."""
    parts = urlsplit(value.strip())
    if parts.scheme not in ("https", "http") or not parts.hostname:
        raise Refused(f"{name} must be an http(s) URL.")
    if parts.scheme != "https" and parts.hostname not in LOOPBACK_HOSTS:
        raise Refused(f"{name} must use https (http only for localhost).")
    if parts.username or parts.password or parts.path not in ("", "/") or parts.query or parts.fragment:
        raise Refused(f"{name} must be an origin only, with no credentials or path.")
    return f"{parts.scheme}://{parts.netloc}"


def call(method, url, key, body=None):
    """One request with the service-role key; the decoded JSON answer."""
    request = Request(url, method=method, data=None if body is None else json.dumps(body).encode())
    request.add_header("apikey", key)
    request.add_header("Authorization", f"Bearer {key}")
    request.add_header("Content-Type", "application/json")
    try:
        with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return json.loads(response.read() or b"null")
    except HTTPError as error:
        # The status only: an error body can echo the request.
        raise Refused(f"Supabase answered {error.code} to {method} {urlsplit(url).path}.") from None
    except URLError as error:
        raise Refused(f"Could not reach Supabase: {error.reason}.") from None


def issue(supabase, app, key, email):
    """The super admin's user id and a sign-in link for them."""
    user_id = call("POST", f"{supabase}/rest/v1/rpc/fn_auth_sign_in_target", key, {"_email": email})
    if not user_id:
        raise Refused("That address has no MGM role, so no link was made.")
    roles = call(
        "GET",
        f"{supabase}/rest/v1/user_roles?select=role&user_id=eq.{quote(user_id)}&role=eq.super_admin",
        key,
    )
    if not roles:
        raise Refused("That address is not a super admin, so no link was made.")
    generated = call("POST", f"{supabase}/auth/v1/admin/generate_link", key, {"type": "magiclink", "email": email})
    token_hash = (generated or {}).get("hashed_token")
    if not token_hash:
        raise Refused("Supabase Auth returned no token.")
    return user_id, f"{app}/auth/confirm?{urlencode({'token_hash': token_hash})}"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--supabase-url", required=True, help="the project's URL, https://<ref>.supabase.co")
    parser.add_argument("--app-url", required=True, help="the installation's MGM_APP_URL")
    parser.add_argument("--email", required=True, help="the super admin's sign-in address")
    parser.add_argument("--requested-by", required=True, help="who asked for the link, and how they were confirmed")
    parser.add_argument("--reason", required=True, help="why the normal sign-in email cannot be used")
    args = parser.parse_args(argv)
    email = args.email.strip().lower()
    if not args.requested_by.strip() or not args.reason.strip():
        parser.error("--requested-by and --reason must not be blank")

    try:
        supabase = origin(args.supabase_url, "--supabase-url")
        app = origin(args.app_url, "--app-url")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or getpass.getpass("Service-role key (hidden): ")
        if not key.strip():
            raise Refused("No service-role key.")
        user_id, link = issue(supabase, app, key.strip(), email)
    except Refused as error:
        print(f"No link made: {error}", file=sys.stderr)
        return 1

    record = {
        "event": "auth.emergency_sign_in_link",
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "operator": getpass.getuser(),
        "app": app,
        "email": email,
        "user_id": user_id,
        "requested_by": args.requested_by.strip(),
        "reason": args.reason.strip(),
    }
    print("File this record as the runbook says (docs/runbooks/emergency-sign-in.md):", file=sys.stderr)
    print(json.dumps(record), file=sys.stderr)
    print(
        f"The link below signs in as {email}. It works once, for {LINK_MINUTES} minutes; "
        "a new link or a sign-in email cancels it. Hand it over in person or over a trusted channel.",
        file=sys.stderr,
    )
    print(link)
    return 0


if __name__ == "__main__":
    sys.exit(main())
